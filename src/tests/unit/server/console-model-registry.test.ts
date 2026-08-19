import { describe, expect, it } from "vitest";
import mongoose from "mongoose";

/**
 * Regression guard for the single silent failure mode the console merge
 * introduced.
 *
 * The platform console keeps its own lean, `strict:false` mirrors of nine
 * collections the main app owns (users, organizations, org_members,
 * quotations, pending_emails, audit_logs, orders, customers,
 * beta_applications). While it was a separate Next app those mirrors lived in
 * a separate process. In one process, Mongoose has ONE model registry — and
 * neither registration helper calls bare `mongoose.model(name, schema)` on an
 * already-registered name, so a name clash does NOT throw
 * `OverwriteModelError`. It resolves silently, in whichever order the route
 * bundle happened to evaluate the two modules, and the loser gets the other's
 * schema. Either the main app loses every validator, enum, default and hook,
 * or the console loses the `strict:false` behaviour its extra fields rely on.
 *
 * The mirrors are therefore registered under `Console`-prefixed names, bound
 * to the same collections via each schema's explicit `collection:` option.
 * These assertions fail the moment anything re-introduces a shared name.
 */

// Side-effect imports: evaluating both barrels registers every model.
import "@/server/db/models";
import * as consoleModels from "@/console/server/db/models";

const SHARED_COLLECTIONS = [
  "users",
  "organizations",
  "org_members",
  "quotations",
  "pending_emails",
  "audit_logs",
  "orders",
  "customers",
  "beta_applications",
] as const;

describe("console model registry", () => {
  it("registers the console mirrors under names the main app does not use", () => {
    for (const name of [
      "ConsoleUser",
      "ConsoleOrganization",
      "ConsoleOrgMember",
      "ConsoleQuotation",
      "ConsolePendingEmail",
      "ConsoleAuditLog",
      "ConsoleOrder",
      "ConsoleCustomer",
      "ConsoleBetaApplication",
    ]) {
      expect(mongoose.models[name], `${name} must be registered`).toBeTruthy();
    }
  });

  it("points each mirror at the collection the main app owns", () => {
    const mirrored = [
      consoleModels.User,
      consoleModels.Organization,
      consoleModels.OrgMember,
      consoleModels.Quotation,
      consoleModels.PendingEmail,
      consoleModels.AuditLog,
      consoleModels.Order,
      consoleModels.Customer,
      consoleModels.BetaApplication,
    ].map((m) => m.collection.collectionName);
    expect(mirrored.sort()).toEqual([...SHARED_COLLECTIONS].sort());
  });

  it("leaves the main app's authoritative schemas intact", () => {
    // If a console mirror had hijacked these names, `strict` would be false
    // and the required flags/sub-schemas would be gone.
    const quotation = mongoose.models.Quotation;
    expect(quotation.schema.get("strict")).not.toBe(false);
    expect(quotation.schema.path("fullName")?.isRequired).toBe(true);

    const order = mongoose.models.Order;
    expect(order.schema.get("strict")).not.toBe(false);
    expect(order.schema.path("customer")?.instance).not.toBe("Mixed");

    const user = mongoose.models.User;
    expect(user.schema.get("strict")).not.toBe(false);
  });

  it("keeps the console mirrors permissive", () => {
    // The console writes fields the main app's strict schemas do not declare
    // (Quotation.grantedUserId / grantedAt / grantedBy). They survive only
    // while the mirror it writes through is the lean `strict:false` one.
    expect(consoleModels.Quotation.schema.get("strict")).toBe(false);
    expect(
      consoleModels.Quotation.schema.path("grantedAt"),
      "grantedAt must exist on the console mirror",
    ).toBeTruthy();
  });

  it("keeps the console-owned models unprefixed and exclusive", () => {
    // No main-app counterpart, so no clash to avoid.
    for (const name of ["AdminOtp", "AdminUser", "AdminNote", "AdminAudit"]) {
      expect(mongoose.models[name], `${name} must be registered`).toBeTruthy();
    }
  });

  it("registers no model name twice over one collection by accident", () => {
    const byName = Object.keys(mongoose.models);
    expect(new Set(byName).size).toBe(byName.length);
  });

  it("keeps the admin audit trail append-only", () => {
    // The guarantee is a set of `pre` hooks on the console's own schema. It
    // survives only because no main-app model registers `AdminAudit` — a
    // clash would swap in a schema without them and make the tamper-evident
    // audit trail silently mutable.
    const hooked = [
      "updateOne",
      "updateMany",
      "replaceOne",
      "findOneAndUpdate",
      "findOneAndReplace",
      "deleteOne",
      "deleteMany",
      "findOneAndDelete",
      "save",
    ];
    const registered = (
      consoleModels.AdminAudit.schema as unknown as {
        s: { hooks: { _pres: Map<string, unknown[]> } };
      }
    ).s.hooks._pres;
    for (const op of hooked) {
      expect(registered.get(op)?.length, `pre(${op}) must be installed`)
        .toBeGreaterThan(0);
    }
    expect(consoleModels.AdminAudit.schema.path("action")?.isRequired).toBe(
      true,
    );
  });
});
