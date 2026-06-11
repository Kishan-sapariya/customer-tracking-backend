import { z } from "zod";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getAllSettings, setSetting } from "../services/settings.service.js";

// GET /api/settings — readable by all roles (cutoff/theme defaults)
export const get = asyncHandler(async (_req, res) => {
  res.json({ data: await getAllSettings() });
});

const updateSchema = z.object({
  cutoffDate: z.string().optional(),
  cutoffField: z.enum(["goLiveDate", "billDate", "entryDate"]).optional(),
  theme: z.string().optional(),
});

// PUT /api/settings — Master only (FR-7.3, §13.1)
export const update = asyncHandler(async (req, res) => {
  const data = updateSchema.parse(req.body);
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) await setSetting(k, v);
  }
  res.json({ message: "Settings saved", data: await getAllSettings() });
});
