import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  singleEntrySchema,
  bulkImportSchema,
  deliverySchema,
  billingSchema,
  ftbSchema,
  lifecycleActionSchema,
  listQuerySchema,
  customerInputSchema,
  editChangeSchema,
} from "../schemas/customer.schema.js";
import * as svc from "../services/customer.service.js";
import type { CustomerType } from "@prisma/client";

// GET /api/customers
export const list = asyncHandler(async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  const { items, pagination } = await svc.listCustomers(q);
  res.json({ items, pagination });
});

// GET /api/customers/export — all rows matching filter (FR-8.3)
export const exportAll = asyncHandler(async (req, res) => {
  const q = listQuerySchema.parse(req.query);
  const items = await svc.listAllForExport(q);
  res.json({ items, pagination: { total: items.length } });
});

// GET /api/customers/sams — distinct SAM Executive names for the filter dropdown
export const sams = asyncHandler(async (_req, res) => {
  const items = await svc.listDistinctSams();
  res.json({ items });
});

// GET /api/changes — commercial-change report (ARC-change audit, all roles)
const changesQuerySchema = z.object({
  action: z.enum(["UPGRADE", "DOWNGRADE", "RATE_REVISION", "DISCONNECTION"]).optional(),
  type: z.enum(["OLD", "NEW"]).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(5000).default(25),
});

export const changes = asyncHandler(async (req, res) => {
  const q = changesQuerySchema.parse(req.query);
  const { items, pagination, summary } = await svc.listCommercialChanges(q);
  res.json({ items, pagination, summary });
});

// PATCH /api/changes/:id — edit a recorded commercial change (Accounts / Master)
export const editChange = asyncHandler(async (req, res) => {
  const body = editChangeSchema.parse(req.body);
  const updated = await svc.editCommercialChange(req.params.id, body, req.user!);
  res.json({ message: "Change updated", data: updated });
});

// DELETE /api/changes/:id — delete a recorded commercial change (Admin / Master)
export const deleteChange = asyncHandler(async (req, res) => {
  await svc.deleteCommercialChange(req.params.id, req.user!);
  res.json({ message: "Change deleted" });
});

// GET /api/customers/:id
export const detail = asyncHandler(async (req, res) => {
  const customer = await svc.getCustomer(req.params.id);
  res.json({ data: customer });
});

// POST /api/customers/old  (Tab 1 single entry — auto-COMPLETED, FR-2.2)
export const createOld = asyncHandler(async (req, res) => {
  const input = singleEntrySchema.parse(req.body);
  const customer = await svc.createSingle(input, "OLD", req.user!);
  res.status(201).json({ message: "Old customer added", data: customer });
});

// POST /api/customers/new  (Tab 2 single entry — enters pipeline, FR-3.2)
export const createNew = asyncHandler(async (req, res) => {
  const input = singleEntrySchema.parse(req.body);
  const customer = await svc.createSingle(input, "NEW", req.user!);
  res.status(201).json({ message: "New customer added to pipeline", data: customer });
});

// POST /api/customers/:type/preview — validate Excel rows before commit (FR-2.4)
export const preview = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const result = svc.previewRows(rows);
  const valid = result.filter((r) => r.valid).length;
  res.json({
    data: {
      rows: result,
      summary: { total: result.length, valid, invalid: result.length - valid },
    },
  });
});

// POST /api/customers/:type/import — commit bulk (FR-2.4 / FR-3.1)
export const bulkImport = asyncHandler(async (req, res) => {
  const type = (req.params.type === "new" ? "NEW" : "OLD") as CustomerType;
  const { rows, onDuplicate, blockOnError } = bulkImportSchema.parse(req.body);
  const result = await svc.bulkImport(rows, type, onDuplicate, blockOnError, req.user!);
  res.json({ message: "Import processed", data: result });
});

// PUT /api/customers/:id — edit master (Accounts & Master only, FR-4.4)
export const edit = asyncHandler(async (req, res) => {
  const input = customerInputSchema.parse(req.body);
  const customer = await svc.editCustomer(req.params.id, input, req.user!);
  res.json({ message: "Customer updated", data: customer });
});

// ── Pipeline steps ───────────────────────────────────────────────────────────
// POST /api/customers/:id/delivery (Delivery / Accounts / Master, FR-3.4)
export const setDelivery = asyncHandler(async (req, res) => {
  const body = deliverySchema.parse(req.body);
  const customer = await svc.setDelivery(req.params.id, body, req.user!);
  res.json({ message: "Delivery recorded", data: customer });
});

// POST /api/customers/:id/billing (Accounts / Master, FR-3.5)
export const setBilling = asyncHandler(async (req, res) => {
  const body = billingSchema.parse(req.body);
  const customer = await svc.setBilling(req.params.id, body, req.user!);
  res.json({ message: "Billing recorded", data: customer });
});

// POST /api/customers/:id/ftb (Accounts / Master, FR-3.6)
export const setFtb = asyncHandler(async (req, res) => {
  const body = ftbSchema.parse(req.body);
  const customer = await svc.setFtb(req.params.id, body, req.user!);
  res.json({ message: "FTB recorded — customer completed", data: customer });
});

// POST /api/customers/:id/action (Accounts / Master, FR-5)
export const action = asyncHandler(async (req, res) => {
  const body = lifecycleActionSchema.parse(req.body);
  const customer = await svc.lifecycleAction(req.params.id, body, req.user!);
  res.json({ message: "Action completed", data: customer });
});
