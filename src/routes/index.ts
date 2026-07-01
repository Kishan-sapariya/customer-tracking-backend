import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth.js";
import * as auth from "../controllers/auth.controller.js";
import * as customers from "../controllers/customer.controller.js";
import * as stats from "../controllers/stats.controller.js";
import * as users from "../controllers/user.controller.js";
import * as settings from "../controllers/settings.controller.js";

const router = Router();

// ── Auth ─────────────────────────────────────────────────────────────────────
router.post("/auth/login", auth.login);
router.get("/auth/me", authenticate, auth.me);
router.post("/auth/change-password", authenticate, auth.changePassword);

// ── Stats (all roles can view — FR-6) ────────────────────────────────────────
router.get("/stats", authenticate, stats.dashboard);

// ── Customers ────────────────────────────────────────────────────────────────
// Read (all roles)
router.get("/customers", authenticate, customers.list);
router.get("/customers/export", authenticate, customers.exportAll);
router.get("/customers/sams", authenticate, customers.sams); // distinct SAM names (must precede :id)
router.get("/changes", authenticate, customers.changes);
router.get("/customers/:id", authenticate, customers.detail);

// Create / import (Accounts & Master)
const writers = requireRole("ACCOUNTS", "MASTER");
router.post("/customers/old", authenticate, writers, customers.createOld);
router.post("/customers/new", authenticate, writers, customers.createNew);
router.post("/customers/:type/preview", authenticate, writers, customers.preview);
router.post("/customers/:type/import", authenticate, writers, customers.bulkImport);
router.put("/customers/:id", authenticate, writers, customers.edit);
router.patch("/changes/:id", authenticate, writers, customers.editChange);
router.delete("/changes/:id", authenticate, requireRole("ADMIN", "MASTER"), customers.deleteChange);

// Pipeline: delivery (Delivery, Accounts, Master); billing/ftb (Accounts, Master)
router.post(
  "/customers/:id/delivery",
  authenticate,
  requireRole("DELIVERY", "ACCOUNTS", "MASTER"),
  customers.setDelivery
);
router.post("/customers/:id/billing", authenticate, writers, customers.setBilling);
router.post("/customers/:id/ftb", authenticate, writers, customers.setFtb);

// Lifecycle actions (Accounts, Master)
router.post("/customers/:id/action", authenticate, writers, customers.action);

// ── Users (Admin & Master — FR-1.4) ──────────────────────────────────────────
const userAdmins = requireRole("ADMIN", "MASTER");
router.get("/users", authenticate, userAdmins, users.list);
router.post("/users", authenticate, userAdmins, users.create);
router.put("/users/:id", authenticate, userAdmins, users.update);
router.post("/users/:id/reset-password", authenticate, userAdmins, users.resetPassword);

// ── Settings (read: all; write: Master — FR-7.3) ─────────────────────────────
router.get("/settings", authenticate, settings.get);
router.put("/settings", authenticate, requireRole("MASTER"), settings.update);

export default router;
