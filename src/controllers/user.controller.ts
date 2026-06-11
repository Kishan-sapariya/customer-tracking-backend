import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import {
  createUserSchema,
  updateUserSchema,
  resetPasswordSchema,
} from "../schemas/auth.schema.js";

const safeSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

// GET /api/users (Admin / Master)
export const list = asyncHandler(async (_req, res) => {
  const items = await prisma.user.findMany({ select: safeSelect, orderBy: { createdAt: "desc" } });
  res.json({ items, pagination: { total: items.length } });
});

// POST /api/users (Admin / Master, FR-1.4)
export const create = asyncHandler(async (req, res) => {
  const { name, email, password, role } = createUserSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email: email.toLowerCase(), passwordHash, role },
    select: safeSelect,
  });
  res.status(201).json({ message: "User created", data: user });
});

// PUT /api/users/:id (Admin / Master) — name/role/enable-disable
export const update = asyncHandler(async (req, res) => {
  const data = updateUserSchema.parse(req.body);
  const user = await prisma.user.update({ where: { id: req.params.id }, data, select: safeSelect });
  res.json({ message: "User updated", data: user });
});

// POST /api/users/:id/reset-password (Admin / Master, FR-1.4)
export const resetPassword = asyncHandler(async (req, res) => {
  const { newPassword } = resetPasswordSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash } });
  res.json({ message: "Password reset" });
});
