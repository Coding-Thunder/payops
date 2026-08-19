import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's admin allow-list is DB-only.
 *
 * There used to be an `ADMIN_ALLOWLIST` env var whose addresses were always
 * allowed, checked BEFORE the database and never revocable from the console.
 * These tests pin the replacement: `admin_users` is the sole authority, and
 * setting that env var again must grant nothing.
 */

const findOne = vi.fn();
const updateOne = vi.fn();
const countDocuments = vi.fn();
const connectMongo = vi.fn(async () => undefined);

vi.mock("@/console/server/db/mongoose", () => ({
  connectMongo: () => connectMongo(),
}));

vi.mock("@/console/server/db/models", () => ({
  AdminUser: {
    findOne: (...args: unknown[]) => findOne(...args),
    updateOne: (...args: unknown[]) => updateOne(...args),
    countDocuments: (...args: unknown[]) => countDocuments(...args),
  },
}));

/** Mirrors the real chain: `findOne(...).select(...).lean()`. */
function resolvesTo(doc: unknown) {
  return { select: () => ({ lean: async () => doc }) };
}

import {
  isAllowedEmail,
  normalizeEmail,
} from "@/console/server/auth/allowlist";
import * as allowlistModule from "@/console/server/auth/allowlist";

beforeEach(() => {
  findOne.mockReset();
  updateOne.mockReset();
  countDocuments.mockReset();
  delete process.env.ADMIN_ALLOWLIST;
});

describe("console allow-list — DB is the only authority", () => {
  it("1. allows an ACTIVE admin_users row", async () => {
    findOne.mockReturnValue(resolvesTo({ _id: "abc" }));
    await expect(isAllowedEmail("ops@example.com")).resolves.toBe(true);
    // The status filter is part of the query, not a post-filter.
    expect(findOne).toHaveBeenCalledWith({
      email: "ops@example.com",
      status: "ACTIVE",
    });
  });

  it("2. rejects an admin whose row is not ACTIVE", async () => {
    // A DISABLED row does not match `{ status: "ACTIVE" }`, so the query
    // returns null.
    findOne.mockReturnValue(resolvesTo(null));
    await expect(isAllowedEmail("disabled@example.com")).resolves.toBe(false);
  });

  it("3. rejects an email with no admin_users row at all", async () => {
    findOne.mockReturnValue(resolvesTo(null));
    await expect(isAllowedEmail("ghost@example.com")).resolves.toBe(false);
  });

  it("4. rejects a non-admin email, and empty/null input", async () => {
    findOne.mockReturnValue(resolvesTo(null));
    await expect(isAllowedEmail("random@example.com")).resolves.toBe(false);
    await expect(isAllowedEmail("")).resolves.toBe(false);
    await expect(isAllowedEmail(null)).resolves.toBe(false);
    await expect(isAllowedEmail(undefined)).resolves.toBe(false);
    // Null/empty short-circuit before touching the DB.
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it("5. works with no ADMIN_ALLOWLIST configured — and ignores it if set", async () => {
    // Not configured: a valid DB admin still gets in.
    findOne.mockReturnValue(resolvesTo({ _id: "abc" }));
    await expect(isAllowedEmail("ops@example.com")).resolves.toBe(true);

    // Configured again: it must grant NOTHING. This is the regression that
    // matters — the old code checked the env set before querying Mongo.
    process.env.ADMIN_ALLOWLIST = "attacker@example.com,ops@example.com";
    findOne.mockReturnValue(resolvesTo(null));
    await expect(isAllowedEmail("attacker@example.com")).resolves.toBe(false);
    await expect(isAllowedEmail("ops@example.com")).resolves.toBe(false);
  });

  it("6. exposes no bootstrap-specific API any more", () => {
    const exported = Object.keys(allowlistModule).sort();
    expect(exported).toEqual(["isAllowedEmail", "normalizeEmail"]);
    expect(exported).not.toContain("bootstrapAdmins");
    expect(exported).not.toContain("isBootstrapEmail");
  });

  it("fails CLOSED when the database is unreachable", async () => {
    // An outage must never widen access — this is precisely what the env
    // bypass used to paper over.
    findOne.mockImplementation(() => {
      throw new Error("connection timed out");
    });
    await expect(isAllowedEmail("ops@example.com")).resolves.toBe(false);
  });

  it("normalizes case and surrounding whitespace before querying", async () => {
    findOne.mockReturnValue(resolvesTo({ _id: "abc" }));
    await expect(isAllowedEmail("  OPS@Example.COM  ")).resolves.toBe(true);
    expect(findOne).toHaveBeenCalledWith({
      email: "ops@example.com",
      status: "ACTIVE",
    });
    expect(normalizeEmail(" A@B.C ")).toBe("a@b.c");
  });
});

describe("recordAdminLogin — never grants access", () => {
  it("stamps lastLoginAt without upserting", async () => {
    const { recordAdminLogin } = await import(
      "@/console/server/services/admins"
    );
    updateOne.mockResolvedValue({ matchedCount: 1 });
    await recordAdminLogin("  OPS@Example.COM ");

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ email: "ops@example.com" });
    expect(update.$set.lastLoginAt).toBeInstanceOf(Date);

    // The old implementation passed `{ upsert: isBootstrap }` and a
    // `$setOnInsert` block that minted an ACTIVE OWNER row. Logging in must
    // never be able to create an admin.
    expect(options).toBeUndefined();
    expect(update).not.toHaveProperty("$setOnInsert");
  });

  it("does not create a row for an email with no admin_users record", async () => {
    const { recordAdminLogin } = await import(
      "@/console/server/services/admins"
    );
    updateOne.mockResolvedValue({ matchedCount: 0, upsertedId: null });
    await recordAdminLogin("ghost@example.com");
    const [, , options] = updateOne.mock.calls[0];
    expect(options?.upsert).not.toBe(true);
  });
});
