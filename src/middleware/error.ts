import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError } from "../utils/apiError.js";

// Central error handler → CRM response envelope `{ message }` (+ optional
// `details`) with correct status codes (PRD §9.2). Keeps messages
// human-readable for non-technical users (NFR-6).
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ message: err.message, details: err.details });
  }

  if (err instanceof ZodError) {
    const fieldErrors = err.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    }));
    return res.status(400).json({
      message: "Some fields need attention.",
      details: fieldErrors,
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[])?.join(", ") ?? "field";
      return res.status(409).json({ message: `A record with this ${target} already exists.` });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ message: "Record not found." });
    }
  }

  console.error("[unhandled]", err);
  return res.status(500).json({ message: "Something went wrong on our end. Please try again." });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: "Route not found." });
}
