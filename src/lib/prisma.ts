import { PrismaClient } from "@prisma/client";

// Single shared client (avoids exhausting the connection pool in dev watch mode).
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});
