import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

const DEFAULTS: Record<string, string> = {
  cutoffDate: env.defaultCutoffDate, // OLD = before, NEW = on/after (PRD §3)
  cutoffField: "goLiveDate", // which field decides OLD/NEW (PRD §13.1 default)
  theme: "cyan",
};

export async function getSetting(key: string): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key] ?? "";
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await prisma.setting.findMany();
  const map = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function getCutoffDate(): Promise<Date> {
  return new Date(await getSetting("cutoffDate"));
}
