import { PrismaClient, type CustomerType, type CustomerStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Demo users. `from` is the legacy email so re-seeding an existing DB updates
  // the SAME row in place (preserving the id that customers reference) instead
  // of leaving stale logins behind.
  const users = [
    { from: "master@ill.com", name: "Admin", email: "admin@email.com", role: "MASTER" as const, password: "admin123" },
    { from: "accounts@ill.com", name: "Accounts", email: "account@email.com", role: "ACCOUNTS" as const, password: "123456" },
    { from: "delivery@ill.com", name: "Delivery", email: "delivery@email.com", role: "DELIVERY" as const, password: "delivery123" },
    { from: "admin@ill.com", name: "Admin (read-only + users)", email: "viewer@email.com", role: "ADMIN" as const, password: "viewer123" },
  ];

  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    const legacy = await prisma.user.findUnique({ where: { email: u.from } });
    if (legacy) {
      await prisma.user.update({
        where: { id: legacy.id },
        data: { name: u.name, email: u.email, role: u.role, passwordHash, isActive: true },
      });
    } else {
      await prisma.user.upsert({
        where: { email: u.email },
        create: { name: u.name, email: u.email, role: u.role, passwordHash },
        update: { name: u.name, role: u.role, passwordHash, isActive: true },
      });
    }
  }
  console.log("✓ Seeded demo users — admin@email.com/admin123, account@email.com/123456");

  // Settings defaults
  await prisma.setting.upsert({
    where: { key: "cutoffDate" },
    create: { key: "cutoffDate", value: "2026-04-01" },
    update: {},
  });
  await prisma.setting.upsert({
    where: { key: "theme" },
    create: { key: "theme", value: "cyan" },
    update: {},
  });

  const master = await prisma.user.findUniqueOrThrow({ where: { email: "admin@email.com" } });

  // Sample customers (only if register is empty) so dashboards aren't blank.
  const count = await prisma.customer.count();
  if (count === 0) {
    let seq = 0;
    const nextCode = () => `ILL-${String(++seq).padStart(5, "0")}`;

    const samples: {
      company: string;
      type: CustomerType;
      status: CustomerStatus;
      isActive: boolean;
      arc: number;
      bw: string;
      city: string;
    }[] = [
      { company: "BlueWave Solutions", type: "NEW", status: "DELIVERY_PENDING", isActive: true, arc: 375000, bw: "100 Mbps", city: "Pune" },
      { company: "Nimbus Tech", type: "NEW", status: "BILLING_PENDING", isActive: true, arc: 240000, bw: "50 Mbps", city: "Mumbai" },
      { company: "Crestline Logistics", type: "NEW", status: "FTB_PENDING", isActive: true, arc: 600000, bw: "200 Mbps", city: "Bengaluru" },
      { company: "Aether Media", type: "NEW", status: "COMPLETED", isActive: true, arc: 180000, bw: "40 Mbps", city: "Hyderabad" },
      { company: "Orion Foods (Legacy)", type: "OLD", status: "COMPLETED", isActive: true, arc: 300000, bw: "80 Mbps", city: "Delhi" },
      { company: "Vertex Mills (Legacy)", type: "OLD", status: "COMPLETED", isActive: true, arc: 450000, bw: "150 Mbps", city: "Surat" },
      { company: "Summit Hotels (Legacy)", type: "OLD", status: "DISCONNECTED", isActive: false, arc: 200000, bw: "60 Mbps", city: "Jaipur" },
    ];

    for (const s of samples) {
      const code = nextCode();
      await prisma.customer.create({
        data: {
          customerCode: code,
          company: s.company,
          contactName: "Contact Person",
          phone: "9000000000",
          email: `info@${s.company.split(" ")[0].toLowerCase()}.com`,
          city: s.city,
          customerType: s.type,
          status: s.status,
          isActive: s.isActive,
          needsReview: s.type === "OLD",
          bandwidth: s.bw,
          arcAmount: s.arc,
          otcAmount: 5000,
          disconnectedAt: s.status === "DISCONNECTED" ? new Date("2026-05-01") : null,
          disconnectReason: s.status === "DISCONNECTED" ? "Non-renewal" : null,
          details: {
            identity: { company: s.company, customerCode: code },
            service: { product: "ILL", bandwidth: s.bw },
            financials: { arcAmount: s.arc, otcAmount: 5000 },
            address: { city: s.city },
            meta: { source: "SINGLE", notes: "Seed sample" },
          },
          source: "SINGLE",
          createdById: master.id,
          history: { create: { action: "CREATED", newValues: { status: s.status }, performedById: master.id } },
        },
      });
    }
    // Keep the code counter ahead of seeded codes.
    await prisma.counter.upsert({
      where: { key: "customerCode:ILL" },
      create: { key: "customerCode:ILL", value: seq },
      update: { value: seq },
    });
    console.log(`✓ Seeded ${samples.length} sample customers`);
  }

  console.log("✅ Seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
