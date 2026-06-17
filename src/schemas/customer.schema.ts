import { z } from "zod";

// ── Shared enums (kept in sync with Prisma) ──────────────────────────────────
export const BillingCycleEnum = z.enum(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"]);
export const CustomerTypeEnum = z.enum(["OLD", "NEW"]);
export const CustomerStatusEnum = z.enum([
  "DELIVERY_PENDING",
  "BILLING_PENDING",
  "FTB_PENDING",
  "COMPLETED",
  "DISCONNECTED",
]);

// Coerce loose Excel/JSON values into clean numbers. Empty string → undefined.
const looseNumber = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s₹]/g, ""));
    return Number.isNaN(n) ? v : n;
  }
  return v;
}, z.number().nonnegative().optional());

// Robust date parsing for migrated sheets. Handles real Date cells, ISO strings,
// and the common "DD-Mon-YY" / "DD-Mon-YYYY" export format (e.g. "31-Aug-20").
// Returns undefined for anything unparseable so legacy imports aren't blocked.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
export function parseLooseDate(v: unknown): Date | undefined {
  if (v === "" || v === null || v === undefined) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  const s = String(v).trim();
  if (!s) return undefined;

  // DD-Mon-YY(YY) or DD/Mon/YY — e.g. 31-Aug-20, 1-Jul-2023
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let year = Number(m[3]);
    if (m[3].length <= 2) year += year < 70 ? 2000 : 1900;
    if (mon !== undefined) {
      const d = new Date(year, mon, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const looseDate = z.preprocess((v) => parseLooseDate(v), z.date().optional());

// Bandwidth like "50" (just Mbps number) → "50 Mbps"; "100 Mbps" stays as-is.
const bandwidthField = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return `${s} Mbps`;
  return s;
}, z.string().optional());

const trimmedString = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string()
);
const optionalString = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().optional()
);

// ── The ONE customer definition (PRD §7, §12.3) ──────────────────────────────
const looseCurrency = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s₹]/g, ""));
    return Number.isNaN(n) ? v : n;
  }
  return v;
}, z.number().nonnegative().optional());

// Migration-friendly: capture email/phone as-is and never reject the row on
// format. Legacy sheets carry multi-value, "NA", and odd-format cells; the goal
// is to get the customer into the register, not to gatekeep contact fields.
const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  z.string().optional()
);
const optionalPhone = optionalString;

// Validates: Excel row → API body → form. Generates the TS type.
// Mirrors the main CRM's Add-Customer field set (Contact, Financial, Address,
// PO & Billing, Contact Persons, Network & SAM). Only `company` is hard-required
// so bulk migration of legacy rows isn't blocked; the rest are captured losslessly.
export const customerInputSchema = z.object({
  customerCode: optionalString, // auto-generated if blank

  // ── Contact Information ──
  company: trimmedString.pipe(z.string().min(1, "Company is required")),
  name: optionalString, // full name
  firstName: optionalString,
  lastName: optionalString,
  contactName: optionalString, // derived if not given (name / first+last)
  phone: optionalPhone,
  email: optionalEmail,
  city: optionalString,
  state: optionalString,

  // ── Financial Details ──
  arcAmount: looseCurrency,
  otcAmount: looseCurrency,
  gstNumber: optionalString,
  legalName: optionalString, // legal name as per GST
  panNumber: optionalString,
  tanNumber: optionalString,

  // ── Address Details ──
  installationAddress: optionalString,
  installationPincode: optionalString,
  billingAddress: optionalString,
  billingPincode: optionalString,

  // ── PO & Billing ──
  // poExpiryDate is never entered manually — it's always computed as
  // billDate + 1 year (see customer.service buildDetails / setBilling).
  poNumber: optionalString,
  billDate: looseDate,
  billingCycle: z.preprocess(
    (v) => (v === "" || v === null ? undefined : typeof v === "string" ? v.toUpperCase() : v),
    BillingCycleEnum.optional()
  ),

  // ── Contact Persons ──
  techInchargeMobile: optionalPhone,
  techInchargeEmail: optionalEmail,
  accountsInchargeMobile: optionalPhone,
  accountsInchargeEmail: optionalEmail,
  bdmName: optionalString,
  serviceManager: optionalString,

  // ── Network & SAM ──
  bandwidth: bandwidthField, // "50" → "50 Mbps"
  numberOfIPs: looseNumber,
  ipAddresses: optionalString, // comma-separated
  circuitId: optionalString,
  username: optionalString, // customer username
  samExecutiveName: optionalString,

  // ── Migration extras (from legacy CRM sheets) ──
  accountManager: optionalString, // relationship manager (shown as assignee)
  circle: optionalString, // telecom circle / locality
  industryType: optionalString,
  statusText: optionalString, // "Active" / "Deactive" → isActive on import

  // ── Misc ──
  goLiveDate: looseDate, // drives OLD/NEW inference vs cutoff
  notes: optionalString,
});

export type CustomerInput = z.infer<typeof customerInputSchema>;

// Single-entry API body adds an optional explicit type override (PRD §12.2:
// auto-infer from cutoff, but allow per-entry override for edge cases).
export const singleEntrySchema = customerInputSchema.extend({
  customerTypeOverride: CustomerTypeEnum.optional(),
});
export type SingleEntryInput = z.infer<typeof singleEntrySchema>;

// Bulk import: array of rows + commit options.
export const bulkImportSchema = z.object({
  rows: z.array(z.record(z.any())).min(1, "No rows to import"),
  onDuplicate: z.enum(["skip", "update", "error"]).default("skip"),
  blockOnError: z.boolean().default(false),
});

// ── Pipeline step bodies (new customers) ─────────────────────────────────────
export const deliverySchema = z.object({
  deliveryDate: z.coerce.date(),
  deliveryNotes: z.string().optional(),
});

// Billing details that move BILLING_PENDING → FTB_PENDING (PRD §13.3 default:
// require cycle + ARC; bill number/date optional snapshot).
export const billingSchema = z.object({
  billingCycle: BillingCycleEnum,
  arcAmount: z.number().nonnegative(),
  billNumber: z.string().optional(),
  billDate: z.coerce.date().optional(),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  taxesNote: z.string().optional(),
});

export const ftbSchema = z.object({
  ftbAmount: z.number().nonnegative(),
  ftbReceivedDate: z.coerce.date(),
});

// ── Lifecycle actions (PRD §5.5) ─────────────────────────────────────────────
export const lifecycleActionSchema = z.object({
  action: z.enum(["UPGRADE", "DOWNGRADE", "RATE_REVISION", "DISCONNECTION", "RECONNECTION"]),
  newBandwidth: z.string().optional(),
  newArcAmount: z.number().nonnegative().optional(),
  reason: z.string().optional(),
  effectiveDate: z.coerce.date().optional(),
});
export type LifecycleActionInput = z.infer<typeof lifecycleActionSchema>;

// List query params (search/filter/sort/paginate — FR-4.2).
export const listQuerySchema = z.object({
  search: z.string().optional(),
  type: CustomerTypeEnum.optional(),
  status: CustomerStatusEnum.optional(),
  active: z.enum(["true", "false"]).optional(),
  needsReview: z.enum(["true", "false"]).optional(),
  sam: z.string().optional(), // exact SAM Executive name (details.sam.samExecutiveName)
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z.enum(["createdAt", "company", "customerCode", "arcAmount", "status"]).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(5000).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
