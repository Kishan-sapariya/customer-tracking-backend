import { asyncHandler } from "../utils/asyncHandler.js";
import * as stats from "../services/stats.service.js";

// GET /api/stats — dashboard counts (all via aggregation)
export const dashboard = asyncHandler(async (_req, res) => {
  const [counts, arc, commercial, trend, oldVsNew, fy] = await Promise.all([
    stats.getDashboardStats(),
    stats.getArcTotals(),
    stats.getCommercialChanges(),
    stats.getMonthlyTrend(),
    stats.getOldVsNew(),
    stats.getCurrentFyLabel(),
  ]);
  res.json({ data: { counts, arc, commercial, trend, oldVsNew, fy } });
});
