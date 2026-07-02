import { asyncHandler } from "../utils/asyncHandler.js";
import * as stats from "../services/stats.service.js";

// GET /api/stats — dashboard counts (all via aggregation)
export const dashboard = asyncHandler(async (_req, res) => {
  const [counts, arc, commercial, commercialByType, commercialPeriods, trend, oldVsNew, fy] = await Promise.all([
    stats.getDashboardStats(),
    stats.getArcTotals(),
    stats.getCommercialChanges(),
    stats.getCommercialByType(),
    stats.getCommercialPeriods(),
    stats.getMonthlyTrend(),
    stats.getOldVsNew(),
    stats.getCurrentFyLabel(),
  ]);
  res.json({ data: { counts, arc, commercial, commercialByType, commercialPeriods, trend, oldVsNew, fy } });
});
