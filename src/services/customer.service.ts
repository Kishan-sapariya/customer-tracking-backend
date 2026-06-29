import { Prisma } from "@prisma/client";
import type {
  CustomerType,
  CustomerStatus,
  EntrySource,
  HistoryAction,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { nextCustomerCode } from "../utils/customerCode.js";
import { ApiError } from "../utils/apiError.js";
import { getCutoffDate } from "./settings.service.js";
import {
  customerInputSchema,
  type CustomerInput,
  type ListQuery,
  type LifecycleActionInput,
} from "../schemas/customer.schema.js";
import type { AuthUser } from "../middleware/auth.js";

// ── Snapshot builder: validated input → lossless `details` JSON (PRD §6.3) ────
// PO expiry is always 1 year from the bill date (business rule).
function addOneYear(date: Date): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function deriveContactName(input: CustomerInput): string | null {
  if (input.contactName) return input.contactName;
  if (input.name) return input.name;
  const fl = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  return fl || null;
}

// Pull an Indian 6-digit PIN out of a free-text address (usually the last
// number — e.g. "…, Pune, 411048"). Takes the LAST match so a circuit id earlier
// in the string isn't mistaken for it. Also handles the "3 space/dash 3" form
// (e.g. "411 004", "416-013").
function extractPincode(address?: string | null): string | null {
  if (!address) return null;
  const s = String(address);
  const six = s.match(/\b\d{6}\b/g);
  if (six) return six[six.length - 1];
  const spaced = s.match(/\b\d{3}[\s-]\d{3}\b/g);
  if (spaced) return spaced[spaced.length - 1].replace(/[\s-]/g, "");
  return null;
}

function buildDetails(input: CustomerInput, extra: Record<string, unknown> = {}) {
  // Fall back to a pincode parsed from the address when not given (or blank).
  // Use `||` (not `??`) so an empty-string column also triggers extraction.
  const installationPincode =
    input.installationPincode?.trim() || extractPincode(input.installationAddress) || null;
  const billingPincode =
    input.billingPincode?.trim() ||
    extractPincode(input.billingAddress) ||
    installationPincode ||
    null;
  return {
    identity: {
      company: input.company,
      customerCode: input.customerCode ?? null,
      gstNumber: input.gstNumber ?? null,
      legalName: input.legalName ?? null,
      panNumber: input.panNumber ?? null,
      tanNumber: input.tanNumber ?? null,
    },
    contact: {
      name: input.name ?? deriveContactName(input),
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
    },
    address: {
      installation: input.installationAddress ?? null,
      installationPincode,
      billing: input.billingAddress ?? null,
      billingPincode,
      city: input.city ?? input.circle ?? null,
      circle: input.circle ?? null,
      state: input.state ?? null,
      pincode: installationPincode,
    },
    service: {
      product: "ILL",
      bandwidth: input.bandwidth ?? null,
      numberOfIPs: input.numberOfIPs ?? null,
      ipAddresses: input.ipAddresses ?? null,
      circuitId: input.circuitId ?? null,
      username: input.username ?? null,
      industryType: input.industryType ?? null,
    },
    financials: {
      arcAmount: input.arcAmount ?? null,
      otcAmount: input.otcAmount ?? null,
    },
    billing: {
      cycle: input.billingCycle ?? null,
      poNumber: input.poNumber ?? null,
      billDate: input.billDate ?? null,
      // Always bill date + 1 year; null until a bill date exists.
      poExpiryDate: input.billDate ? addOneYear(input.billDate) : null,
    },
    contactPersons: {
      techInchargeMobile: input.techInchargeMobile ?? null,
      techInchargeEmail: input.techInchargeEmail ?? null,
      accountsInchargeMobile: input.accountsInchargeMobile ?? null,
      accountsInchargeEmail: input.accountsInchargeEmail ?? null,
      bdmName: input.bdmName ?? null,
      accountManager: input.accountManager ?? null,
      serviceManager: input.serviceManager ?? null,
    },
    sam: {
      samExecutiveName: input.samExecutiveName ?? null,
    },
    lifecycle: {
      goLiveDate: input.goLiveDate ?? null,
    },
    meta: {
      notes: input.notes ?? null,
    },
    ...extra,
  };
}

// Cutoff inference (PRD §12.2): OLD if go-live before cutoff, else NEW.
export async function inferType(goLiveDate?: Date): Promise<CustomerType | null> {
  if (!goLiveDate) return null;
  const cutoff = await getCutoffDate();
  return goLiveDate < cutoff ? "OLD" : "NEW";
}

// Columns derived from / kept in sync with the JSON on write (PRD §6.2 note).
function toColumns(input: CustomerInput) {
  return {
    company: input.company,
    contactName: deriveContactName(input),
    phone: input.phone ?? null,
    email: input.email ?? null,
    city: input.city ?? input.circle ?? null,
    username: input.username ?? null,
    bandwidth: input.bandwidth ?? null,
    arcAmount: input.arcAmount ?? null,
    otcAmount: input.otcAmount ?? null,
    billingCycle: input.billingCycle ?? null,
  };
}

// ── Create a single customer (used by both tabs + each bulk row) ─────────────
// OLD → COMPLETED immediately (FR-2.2). NEW → DELIVERY_PENDING pipeline (FR-3.2).
async function createOne(
  tx: Prisma.TransactionClient,
  input: CustomerInput,
  type: CustomerType,
  source: EntrySource,
  user: AuthUser,
  opts: { needsReview?: boolean } = {}
) {
  const code = input.customerCode?.trim() || (await nextCustomerCode(tx));

  // De-dupe on customer code (natural key, PRD §12.5).
  const existing = await tx.customer.findUnique({ where: { customerCode: code } });
  if (existing) {
    throw ApiError.conflict(`Customer code ${code} already exists`, { code });
  }

  // A legacy "Status" column (Active / Deactive / Inactive / Disconnected) can
  // mark a migrated OLD customer as already disconnected.
  const isDeactive =
    type === "OLD" && /deactiv|inactiv|disconnect|terminat|closed|churn/i.test(input.statusText ?? "");

  const status: CustomerStatus = isDeactive
    ? "DISCONNECTED"
    : type === "OLD"
    ? "COMPLETED"
    : "DELIVERY_PENDING";

  // New customers don't carry a bill date (or computed PO expiry) at creation —
  // those are recorded later in the billing pipeline step.
  if (type === "NEW") input = { ...input, billDate: undefined };

  const inferred = await inferType(input.goLiveDate);
  const details = buildDetails(input, {
    meta: {
      notes: input.notes ?? null,
      source,
      inferredType: inferred,
      typeMismatch: inferred !== null && inferred !== type,
      importedStatus: input.statusText ?? null,
    },
  });

  const customer = await tx.customer.create({
    data: {
      customerCode: code,
      ...toColumns(input),
      customerType: type,
      status,
      isActive: !isDeactive,
      disconnectedAt: isDeactive ? input.billDate ?? null : null,
      disconnectReason: isDeactive ? "Migrated as Deactive" : null,
      needsReview: opts.needsReview ?? false,
      details: details as Prisma.InputJsonValue,
      source,
      createdById: user.id,
    },
  });

  await tx.customerHistory.create({
    data: {
      customerId: customer.id,
      action: "CREATED",
      newValues: { customerType: type, status } as Prisma.InputJsonValue,
      performedById: user.id,
    },
  });

  return customer;
}

export async function createSingle(
  input: CustomerInput,
  type: CustomerType,
  user: AuthUser
) {
  return prisma.$transaction((tx) => createOne(tx, input, type, "SINGLE", user));
}

// ── Bulk import with preview-tested rows (FR-2.4 / FR-3.1) ────────────────────
export interface ImportResult {
  added: number;
  skipped: number;
  errors: { row: number; code?: string; reason: string }[];
  updated: number;
}

export async function bulkImport(
  rawRows: Record<string, unknown>[],
  type: CustomerType,
  onDuplicate: "skip" | "update" | "error",
  blockOnError: boolean,
  user: AuthUser
): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: 0, updated: 0, errors: [] };

  // Validate every row first (transactional per batch — NFR-2/NFR-7).
  const parsed: { row: number; data: CustomerInput }[] = [];
  rawRows.forEach((raw, i) => {
    const res = customerInputSchema.safeParse(normalizeRow(raw));
    if (res.success) parsed.push({ row: i + 2, data: res.data }); // +2: header + 1-index
    else
      result.errors.push({
        row: i + 2,
        reason: res.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
  });

  if (blockOnError && result.errors.length > 0) {
    return result; // dry stop — caller surfaces the error report
  }

  await prisma.$transaction(async (tx) => {
    for (const { row, data } of parsed) {
      try {
        const code = data.customerCode?.trim();
        if (code) {
          const dup = await tx.customer.findUnique({ where: { customerCode: code } });
          if (dup) {
            if (onDuplicate === "skip") {
              result.skipped++;
              continue;
            }
            if (onDuplicate === "error") {
              result.errors.push({ row, code, reason: "Duplicate customer code" });
              continue;
            }
            // update
            await applyEdit(tx, dup.id, data, user, true);
            result.updated++;
            continue;
          }
        }
        // Old imports flagged needsReview for later verification (PRD §12.12).
        await createOne(tx, data, type, "EXCEL", user, { needsReview: type === "OLD" });
        result.added++;
      } catch (e) {
        result.errors.push({
          row,
          code: data.customerCode,
          reason: e instanceof ApiError ? e.message : "Failed to import row",
        });
      }
    }
  }, {
    // Large imports (hundreds/thousands of rows) far exceed Prisma's default
    // 5s interactive-transaction timeout, so raise it for the whole batch.
    maxWait: 30_000,
    timeout: 600_000, // up to 10 minutes for very large sheets
  });

  return result;
}

// Map common Excel header variants → schema keys.
const HEADER_MAP: Record<string, string> = {
  "customer code": "customerCode",
  // Contact Information
  company: "company",
  "company name": "company",
  "customer name": "company", // legacy CRM sheets call the company the "customer"
  name: "name",
  "full name": "name",
  "first name": "firstName",
  "last name": "lastName",
  "contact name": "contactName",
  "contact person name": "contactName",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "contact number(it)": "phone",
  "contact number (it)": "phone",
  email: "email",
  "email id(it)": "email",
  "email id (it)": "email",
  city: "city",
  state: "state",
  // Financial Details
  "arc amount": "arcAmount",
  arc: "arcAmount",
  "otc amount": "otcAmount",
  otc: "otcAmount",
  gst: "gstNumber",
  "gst number": "gstNumber",
  "gst no": "gstNumber",
  "legal name": "legalName",
  pan: "panNumber",
  "pan number": "panNumber",
  tan: "tanNumber",
  "tan number": "tanNumber",
  // Address Details
  "installation address": "installationAddress",
  address: "installationAddress",
  "installation pincode": "installationPincode",
  "billing address": "billingAddress",
  "billing pincode": "billingPincode",
  pincode: "installationPincode",
  // PO & Billing
  "po number": "poNumber",
  "purchase order number": "poNumber",
  "bill date": "billDate",
  "billing start date": "billDate",
  "billing cycle": "billingCycle",
  // Contact Persons
  "tech incharge mobile": "techInchargeMobile",
  "tech incharge email": "techInchargeEmail",
  "accounts incharge mobile": "accountsInchargeMobile",
  "accounts incharge email": "accountsInchargeEmail",
  "bdm name": "bdmName",
  "service manager": "serviceManager",
  // Network & SAM
  bandwidth: "bandwidth",
  "bandwidth (mbps)": "bandwidth",
  "current bw": "bandwidth",
  "current bandwidth": "bandwidth",
  "no. of ips": "numberOfIPs",
  "no of ips": "numberOfIPs",
  "number of ips": "numberOfIPs",
  "ip addresses": "ipAddresses",
  "ip details": "ipAddresses",
  "circuit id": "circuitId",
  username: "username",
  "user name": "username",
  "sam executive name": "samExecutiveName",
  sam: "samExecutiveName",
  // Migration extras
  "account manager": "accountManager",
  circle: "circle",
  "industry type": "industryType",
  industry: "industryType",
  status: "statusText",
  // Misc
  "go-live date": "goLiveDate",
  "go live date": "goLiveDate",
  notes: "notes",
};

export function normalizeRow(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = HEADER_MAP[k.trim().toLowerCase()] ?? k;
    out[key] = v;
  }
  return out;
}

// Validate-only preview (FR-2.4 preview-before-commit).
export function previewRows(rawRows: Record<string, unknown>[]) {
  return rawRows.map((raw, i) => {
    const res = customerInputSchema.safeParse(normalizeRow(raw));
    return res.success
      ? { row: i + 2, valid: true as const, data: res.data }
      : {
          row: i + 2,
          valid: false as const,
          errors: res.error.issues.map((x) => ({
            field: x.path.join("."),
            message: x.message,
          })),
        };
  });
}

// ── List with filters / search / sort / pagination (FR-4.1/4.2) ──────────────
export async function listCustomers(q: ListQuery) {
  const where: Prisma.CustomerWhereInput = {};
  if (q.type) where.customerType = q.type;
  if (q.status) where.status = q.status;
  if (q.active) where.isActive = q.active === "true";
  if (q.needsReview) where.needsReview = q.needsReview === "true";
  // SAM lives inside the `details` JSON, not a column — match on the JSON path.
  if (q.sam) {
    where.details = { path: ["sam", "samExecutiveName"], equals: q.sam };
  }
  if (q.dateFrom || q.dateTo) {
    where.createdAt = {};
    if (q.dateFrom) where.createdAt.gte = q.dateFrom;
    if (q.dateTo) where.createdAt.lte = q.dateTo;
  }
  if (q.search) {
    const s = q.search.trim();
    where.OR = [
      { company: { contains: s, mode: "insensitive" } },
      { contactName: { contains: s, mode: "insensitive" } },
      { phone: { contains: s, mode: "insensitive" } },
      { customerCode: { contains: s, mode: "insensitive" } },
      { email: { contains: s, mode: "insensitive" } },
      { username: { contains: s, mode: "insensitive" } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { [q.sortBy]: q.sortDir },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.customer.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
    },
  };
}

// Distinct SAM Executive names for the filter dropdown. Reads the JSON path
// directly (Prisma can't `distinct` on a JSON sub-field), skipping blanks.
export async function listDistinctSams(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ sam: string }[]>`
    SELECT DISTINCT "details"->'sam'->>'samExecutiveName' AS sam
    FROM "Customer"
    WHERE NULLIF(TRIM("details"->'sam'->>'samExecutiveName'), '') IS NOT NULL
    ORDER BY sam ASC
  `;
  return rows.map((r) => r.sam);
}

export async function getCustomer(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { history: { orderBy: { createdAt: "desc" }, include: { performedBy: { select: { name: true, role: true } } } } },
  });
  if (!customer) throw ApiError.notFound("Customer not found");
  return customer;
}

// ── Pipeline transitions (new customers, FR-3.4/3.5/3.6) ─────────────────────
export async function setDelivery(
  id: string,
  body: { deliveryDate: Date; deliveryNotes?: string },
  user: AuthUser
) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Customer not found");
  if (c.customerType !== "NEW") throw ApiError.badRequest("Delivery applies to new customers only");
  if (c.status !== "DELIVERY_PENDING")
    throw ApiError.badRequest(`Customer is not awaiting delivery (current: ${c.status})`);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id },
      data: {
        deliveryDate: body.deliveryDate,
        deliveryNotes: body.deliveryNotes ?? null,
        status: "BILLING_PENDING",
      },
    });
    await tx.customerHistory.create({
      data: {
        customerId: id,
        action: "DELIVERY_SET",
        oldValues: { status: "DELIVERY_PENDING" },
        newValues: { status: "BILLING_PENDING", deliveryDate: body.deliveryDate } as Prisma.InputJsonValue,
        reason: body.deliveryNotes,
        performedById: user.id,
      },
    });
    return updated;
  });
}

export async function setBilling(
  id: string,
  body: { billingCycle: any; arcAmount: number; [k: string]: unknown },
  user: AuthUser
) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Customer not found");
  if (c.customerType !== "NEW") throw ApiError.badRequest("Billing applies to new customers only");
  if (c.status !== "BILLING_PENDING")
    throw ApiError.badRequest(`Customer is not awaiting billing (current: ${c.status})`);

  // Merge billing into the details snapshot and compute PO expiry (billDate + 1yr).
  const details = ((c.details as Record<string, any>) ?? {});
  const billDate = body.billDate as Date | undefined;
  details.billing = {
    ...(details.billing ?? {}),
    cycle: body.billingCycle,
    billNumber: body.billNumber ?? details.billing?.billNumber ?? null,
    billDate: billDate ?? details.billing?.billDate ?? null,
    poExpiryDate: billDate ? addOneYear(billDate) : (details.billing?.poExpiryDate ?? null),
  };
  details.financials = { ...(details.financials ?? {}), arcAmount: body.arcAmount };

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id },
      data: {
        billingCycle: body.billingCycle,
        arcAmount: body.arcAmount,
        billingDetails: body as Prisma.InputJsonValue,
        details: details as Prisma.InputJsonValue,
        status: "FTB_PENDING",
      },
    });
    await tx.customerHistory.create({
      data: {
        customerId: id,
        action: "BILLING_SET",
        oldValues: { status: "BILLING_PENDING", arcAmount: c.arcAmount },
        newValues: { status: "FTB_PENDING", billingCycle: body.billingCycle, arcAmount: body.arcAmount, billDate: billDate ?? null } as Prisma.InputJsonValue,
        performedById: user.id,
      },
    });
    return updated;
  });
}

export async function setFtb(
  id: string,
  body: { ftbAmount: number; ftbReceivedDate: Date },
  user: AuthUser
) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Customer not found");
  if (c.customerType !== "NEW") throw ApiError.badRequest("FTB applies to new customers only");
  if (c.status !== "FTB_PENDING")
    throw ApiError.badRequest(`Customer is not awaiting FTB (current: ${c.status})`);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id },
      data: {
        ftbAmount: body.ftbAmount,
        ftbReceivedDate: body.ftbReceivedDate,
        status: "COMPLETED",
      },
    });
    await tx.customerHistory.create({
      data: {
        customerId: id,
        action: "FTB_SET",
        oldValues: { status: "FTB_PENDING" },
        newValues: { status: "COMPLETED", ftbAmount: body.ftbAmount, ftbReceivedDate: body.ftbReceivedDate } as Prisma.InputJsonValue,
        performedById: user.id,
      },
    });
    return updated;
  });
}

// ── Lifecycle actions (FR-5) ─────────────────────────────────────────────────
export async function lifecycleAction(id: string, body: LifecycleActionInput, user: AuthUser) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Customer not found");

  const actionToHistory: Record<string, HistoryAction> = {
    UPGRADE: "UPGRADE",
    DOWNGRADE: "DOWNGRADE",
    RATE_REVISION: "RATE_REVISION",
    DISCONNECTION: "DISCONNECTION",
    RECONNECTION: "RECONNECTION",
  };

  if (body.action === "DISCONNECTION") {
    if (!c.isActive) throw ApiError.badRequest("Customer is already disconnected");
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: {
          isActive: false,
          status: "DISCONNECTED",
          disconnectedAt: body.effectiveDate ?? new Date(),
          disconnectReason: body.reason ?? null,
        },
      });
      await tx.customerHistory.create({
        data: {
          customerId: id,
          action: "DISCONNECTION",
          oldValues: { isActive: true, status: c.status },
          newValues: { isActive: false, status: "DISCONNECTED", effectiveDate: body.effectiveDate ?? new Date(), mailReceivedDate: body.mailReceivedDate ?? null } as Prisma.InputJsonValue,
          reason: body.reason,
          performedById: user.id,
        },
      });
      return updated;
    });
  }

  if (body.action === "RECONNECTION") {
    if (c.isActive) throw ApiError.badRequest("Customer is already active");
    return prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: { isActive: true, status: "COMPLETED", disconnectedAt: null, disconnectReason: null },
      });
      await tx.customerHistory.create({
        data: {
          customerId: id,
          action: "RECONNECTION",
          oldValues: { isActive: false, status: "DISCONNECTED" },
          newValues: { isActive: true, status: "COMPLETED", effectiveDate: body.effectiveDate ?? new Date(), mailReceivedDate: body.mailReceivedDate ?? null } as Prisma.InputJsonValue,
          reason: body.reason,
          performedById: user.id,
        },
      });
      return updated;
    });
  }

  // Upgrade / Downgrade / Rate Revision — adjust ARC and/or bandwidth.
  if (!c.isActive) throw ApiError.badRequest("Cannot modify a disconnected customer");
  if (body.newArcAmount === undefined && body.newBandwidth === undefined)
    throw ApiError.badRequest("Provide a new ARC and/or bandwidth");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id },
      data: {
        arcAmount: body.newArcAmount ?? c.arcAmount,
        bandwidth: body.newBandwidth ?? c.bandwidth,
      },
    });
    await tx.customerHistory.create({
      data: {
        customerId: id,
        action: actionToHistory[body.action],
        oldValues: { arcAmount: c.arcAmount, bandwidth: c.bandwidth },
        newValues: {
          arcAmount: updated.arcAmount,
          bandwidth: updated.bandwidth,
          effectiveDate: body.effectiveDate ?? new Date(),
          mailReceivedDate: body.mailReceivedDate ?? null,
        } as Prisma.InputJsonValue,
        reason: body.reason,
        performedById: user.id,
      },
    });
    return updated;
  });
}

// ── Edit (Accounts & Master only) — audit-logged (FR-4.4) ─────────────────────
async function applyEdit(
  tx: Prisma.TransactionClient,
  id: string,
  input: CustomerInput,
  user: AuthUser,
  fromImport = false
) {
  const c = await tx.customer.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Customer not found");

  const cols = toColumns(input);
  const details = buildDetails(input, {
    meta: { ...((c.details as any)?.meta ?? {}), notes: input.notes ?? null, editedViaImport: fromImport },
  });

  const updated = await tx.customer.update({
    where: { id },
    data: { ...cols, details: details as Prisma.InputJsonValue },
  });
  await tx.customerHistory.create({
    data: {
      customerId: id,
      action: "EDIT",
      oldValues: { company: c.company, arcAmount: c.arcAmount, bandwidth: c.bandwidth } as Prisma.InputJsonValue,
      newValues: { company: updated.company, arcAmount: updated.arcAmount, bandwidth: updated.bandwidth } as Prisma.InputJsonValue,
      performedById: user.id,
    },
  });
  return updated;
}

export async function editCustomer(id: string, input: CustomerInput, user: AuthUser) {
  return prisma.$transaction((tx) => applyEdit(tx, id, input, user));
}

// Export streaming: all rows matching a filter (FR-8.3 "export all").
export async function listAllForExport(q: ListQuery) {
  const { items } = await listCustomers({ ...q, page: 1, pageSize: 5000 });
  return items;
}

// ── Commercial changes report (ARC-change audit, PRD §12.13) ─────────────────
const COMMERCIAL_ACTIONS = ["UPGRADE", "DOWNGRADE", "RATE_REVISION", "DISCONNECTION"] as const;

export async function listCommercialChanges(q: { action?: HistoryAction; dateFrom?: Date; dateTo?: Date; page: number; pageSize: number }) {
  const where: Prisma.CustomerHistoryWhereInput = {
    action: q.action ? q.action : { in: COMMERCIAL_ACTIONS as unknown as HistoryAction[] },
  };
  // Filter by when the change was recorded (createdAt).
  if (q.dateFrom || q.dateTo) {
    where.createdAt = {};
    if (q.dateFrom) where.createdAt.gte = q.dateFrom;
    if (q.dateTo) where.createdAt.lte = q.dateTo;
  }
  const [items, total] = await Promise.all([
    prisma.customerHistory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        // `details` carries the circuit id (details.service.circuitId) the
        // commercial-changes export needs as its customer key.
        customer: { select: { id: true, customerCode: true, company: true, arcAmount: true, details: true } },
        performedBy: { select: { name: true, role: true } },
      },
    }),
    prisma.customerHistory.count({ where }),
  ]);
  return {
    items,
    pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
  };
}

// ── Edit a recorded commercial change (correct a mistake) ────────────────────
// Updates the history record's snapshot in place. When the change is the
// customer's MOST RECENT arc/bandwidth-affecting change, the customer's live
// arcAmount / bandwidth are synced too (Accounts & Master only — FR-5).
const ARC_ACTIONS = ["UPGRADE", "DOWNGRADE"] as const; // actions that move ARC
const BW_ACTIONS = ["UPGRADE", "DOWNGRADE", "RATE_REVISION"] as const; // actions that move bandwidth

export interface EditChangeInput {
  newArcAmount?: number;
  newBandwidth?: string;
  effectiveDate?: Date;
  mailReceivedDate?: Date;
  reason?: string;
}

export async function editCommercialChange(id: string, body: EditChangeInput, user: AuthUser) {
  const entry = await prisma.customerHistory.findUnique({ where: { id } });
  if (!entry) throw ApiError.notFound("Change not found");
  if (!(COMMERCIAL_ACTIONS as readonly string[]).includes(entry.action)) {
    throw ApiError.badRequest("Only commercial changes can be edited");
  }

  const prev = (entry.newValues as Record<string, unknown>) ?? {};
  const isArc = (ARC_ACTIONS as readonly string[]).includes(entry.action);
  const isBw = (BW_ACTIONS as readonly string[]).includes(entry.action);

  // Merge edits into the stored snapshot (only fields valid for this action).
  const newValues: Record<string, unknown> = { ...prev };
  if (isArc && body.newArcAmount !== undefined) newValues.arcAmount = body.newArcAmount;
  if (isBw && body.newBandwidth !== undefined) newValues.bandwidth = body.newBandwidth;
  if (body.effectiveDate !== undefined) newValues.effectiveDate = body.effectiveDate;
  if (body.mailReceivedDate !== undefined) newValues.mailReceivedDate = body.mailReceivedDate;

  return prisma.$transaction(async (tx) => {
    await tx.customerHistory.update({
      where: { id },
      data: {
        newValues: newValues as Prisma.InputJsonValue,
        ...(body.reason !== undefined ? { reason: body.reason || null } : {}),
      },
    });

    // Sync the customer's live values only if this is the latest such change.
    const data: Prisma.CustomerUpdateInput = {};
    if (isArc && body.newArcAmount !== undefined) {
      const latestArc = await tx.customerHistory.findFirst({
        where: { customerId: entry.customerId, action: { in: ARC_ACTIONS as unknown as HistoryAction[] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latestArc?.id === id) data.arcAmount = body.newArcAmount;
    }
    if (isBw && body.newBandwidth !== undefined) {
      const latestBw = await tx.customerHistory.findFirst({
        where: { customerId: entry.customerId, action: { in: BW_ACTIONS as unknown as HistoryAction[] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latestBw?.id === id) data.bandwidth = body.newBandwidth;
    }
    if (Object.keys(data).length > 0) {
      await tx.customer.update({ where: { id: entry.customerId }, data });
    }

    return tx.customerHistory.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, customerCode: true, company: true, arcAmount: true, details: true } },
        performedBy: { select: { name: true, role: true } },
      },
    });
  });
}
