import type { Prisma } from "@prisma/client";

// Atomic sequential customer codes (ILL-00001…), mirroring the CRM's
// documentNumber.service pattern (PRD §9.5). Uses an upsert/increment inside
// the caller's transaction so concurrent imports never collide or skip.
export async function nextCustomerCode(
  tx: Prisma.TransactionClient,
  prefix = "ILL"
): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { key: `customerCode:${prefix}` },
    create: { key: `customerCode:${prefix}`, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${String(counter.value).padStart(5, "0")}`;
}
