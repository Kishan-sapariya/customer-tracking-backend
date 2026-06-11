import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { signToken } from "../middleware/auth.js";
import { loginSchema, changePasswordSchema } from "../schemas/auth.schema.js";

// POST /api/auth/login (FR-1.1)
export const login = asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) throw ApiError.unauthorized("Invalid email or password");
  if (!user.isActive) throw ApiError.forbidden("This account is disabled. Contact an administrator."); // FR-1.6

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized("Invalid email or password");

  const safe = { id: user.id, email: user.email, name: user.name, role: user.role };
  const token = signToken(safe);
  res.json({ message: "Logged in", data: { token, user: safe } });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  res.json({ message: "OK", data: { user: req.user } });
});

// POST /api/auth/change-password (FR-1.3)
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw ApiError.notFound("User not found");

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw ApiError.badRequest("Current password is incorrect");

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ message: "Password updated" });
});
