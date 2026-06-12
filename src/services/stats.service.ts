import { prisma } from "../lib/prisma.js";
import { getCutoffDate } from "./settings.service.js";

// All counts via DB aggregation (count/groupBy) — never fetch-all-and-filter
// (PRD §6.2, NFR-1). Returns the numbers behind every clickable stat card.
export async function getDashboardStats() {
  const [
    total,
    old,
    neu,
    active,
    disconnected,
    deliveryPending,
    billingPending,
    ftbPending,
    completed,
  ] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { customerType: "OLD" } }),
    prisma.customer.count({ where: { customerType: "NEW" } }),
    prisma.customer.count({ where: { isActive: true } }),
    prisma.customer.count({ where: { status: "DISCONNECTED" } }),
    prisma.customer.count({ where: { customerType: "NEW", status: "DELIVERY_PENDING" } }),
    prisma.customer.count({ where: { customerType: "NEW", status: "BILLING_PENDING" } }),
    prisma.customer.count({ where: { customerType: "NEW", status: "FTB_PENDING" } }),
    prisma.customer.count({ where: { status: "COMPLETED" } }),
  ]);

  // Data-health: records missing key fields (PRD §12.10).
  const dataHealth = await prisma.customer.count({
    where: {
      OR: [
        { arcAmount: null },
        { bandwidth: null },
        { contactName: null },
      ],
    },
  });

  return {
    total,
    old,
    new: neu,
    active,
    disconnected,
    deliveryPending,
    billingPending,
    ftbPending,
    completed,
    dataHealth,
  };
}

// ARC (Annual Recurring Charge) totals — overall + by type + active book.
export async function getArcTotals() {
  const [total, active, byType] = await Promise.all([
    prisma.customer.aggregate({ _sum: { arcAmount: true } }),
    prisma.customer.aggregate({ where: { isActive: true }, _sum: { arcAmount: true } }),
    prisma.customer.groupBy({ by: ["customerType"], _sum: { arcAmount: true } }),
  ]);
  return {
    total: total._sum.arcAmount ?? 0,
    active: active._sum.arcAmount ?? 0,
    old: byType.find((t) => t.customerType === "OLD")?._sum.arcAmount ?? 0,
    new: byType.find((t) => t.customerType === "NEW")?._sum.arcAmount ?? 0,
  };
}

// Commercial changes (the lifecycle actions that move money). Count + ARC impact
// per action type, computed from the append-only history (FR-5.2 / §12.13).
type Range = { from: Date; to: Date };

async function commercialForRange(range?: Range) {
  const where: any = { action: { in: ["UPGRADE", "DOWNGRADE", "RATE_REVISION"] } };
  if (range) where.createdAt = { gte: range.from, lte: range.to };
  const rows = await prisma.customerHistory.findMany({
    where,
    select: { action: true, oldValues: true, newValues: true },
  });

  const out = {
    upgrade: { count: 0, amount: 0 },
    downgrade: { count: 0, amount: 0 },
    rateRevision: { count: 0, amount: 0 },
    disconnection: { count: 0, amount: 0 },
  };

  for (const r of rows) {
    const oldArc = Number((r.oldValues as any)?.arcAmount ?? 0);
    const newArc = Number((r.newValues as any)?.arcAmount ?? 0);
    if (r.action === "UPGRADE") {
      out.upgrade.count++;
      out.upgrade.amount += Math.max(0, newArc - oldArc); // revenue gained
    } else if (r.action === "DOWNGRADE") {
      out.downgrade.count++;
      out.downgrade.amount += Math.max(0, oldArc - newArc); // revenue reduced
    } else if (r.action === "RATE_REVISION") {
      out.rateRevision.count++; // bandwidth only — no ARC amount
    }
  }

  // Disconnection: ARC churned. For a period, filter on disconnectedAt.
  const discWhere: any = { status: "DISCONNECTED" };
  if (range) discWhere.disconnectedAt = { gte: range.from, lte: range.to };
  const disc = await prisma.customer.aggregate({
    where: discWhere,
    _count: { _all: true },
    _sum: { arcAmount: true },
  });
  out.disconnection = { count: disc._count._all, amount: disc._sum.arcAmount ?? 0 };

  return out;
}

export async function getCommercialChanges() {
  return commercialForRange(); // all-time
}

// Commercial changes bucketed by Indian fiscal quarter (FY starts 1 Apr) +
// all-time, for the dashboard ARC-waterfall period selector.
export async function getCommercialPeriods() {
  const cutoff = await getCutoffDate();
  const y = cutoff.getFullYear(); // FY start year
  const end = (yr: number, m: number, d: number) => new Date(Date.UTC(yr, m, d, 23, 59, 59, 999));
  const start = (yr: number, m: number, d: number) => new Date(Date.UTC(yr, m, d, 0, 0, 0, 0));
  const ranges = {
    q1: { from: start(y, 3, 1), to: end(y, 5, 30) }, // Apr–Jun
    q2: { from: start(y, 6, 1), to: end(y, 8, 30) }, // Jul–Sep
    q3: { from: start(y, 9, 1), to: end(y, 11, 31) }, // Oct–Dec
    q4: { from: start(y + 1, 0, 1), to: end(y + 1, 2, 31) }, // Jan–Mar
  };
  const [all, q1, q2, q3, q4] = await Promise.all([
    commercialForRange(),
    commercialForRange(ranges.q1),
    commercialForRange(ranges.q2),
    commercialForRange(ranges.q3),
    commercialForRange(ranges.q4),
  ]);
  return { all, q1, q2, q3, q4 };
}

// New customers per month for the trend chart (FR-6.3). Grouped in SQL.
export async function getMonthlyTrend() {
  const rows = await prisma.$queryRaw<{ month: string; count: bigint }[]>`
    SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS month,
           count(*)::bigint AS count
    FROM "Customer"
    WHERE "customerType" = 'NEW'
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
}

export async function getOldVsNew() {
  const grouped = await prisma.customer.groupBy({
    by: ["customerType"],
    _count: { _all: true },
  });
  return grouped.map((g) => ({ type: g.customerType, count: g._count._all }));
}

export async function getCurrentFyLabel(): Promise<string> {
  const cutoff = await getCutoffDate();
  const year = cutoff.getFullYear();
  return `${year}-${String(year + 1).slice(2)}`;
}
