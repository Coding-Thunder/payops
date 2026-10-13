import { beforeEach, describe, expect, it, vi } from "vitest";

// The console's admin-session guard and audit writer are mocked: this test is
// about the QUERY being source-aware, not about re-testing authentication,
// which `console-allowlist` and the smoke suite already cover. The guard is
// asserted to have been CALLED, so the authorization hook cannot be dropped
// without this failing.
const assertConsoleAdmin = vi.fn(async () => {});
const getAdminEmail = vi.fn(async () => "admin@tracetxn.com");
const recordAdminAction =
  vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {});

vi.mock("@/console/server/auth/session", () => ({
  assertConsoleAdmin: () => assertConsoleAdmin(),
  getAdminEmail: () => getAdminEmail(),
}));
vi.mock("@/console/server/audit", () => ({
  recordAdminAction: (i: Record<string, unknown>) => recordAdminAction(i),
}));

import { Quotation } from "@/server/db/models";
import {
  getEnquiry,
  listEnquiries,
} from "@/console/server/services/quotations";
import { listWaitlist } from "@/console/server/services/waitlist";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

const PAGE = { page: 1, pageSize: 20, skip: 0, limit: 20 };

async function seed() {
  await Quotation.create({
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    workEmail: "ada@analytical.example",
    useCase: "Thirty client projects, invoices going missing.",
    source: "contact_sales",
    status: "PENDING",
    notificationStatus: "SKIPPED",
    notificationError: "no_recipient_configured",
  });
  await Quotation.create({
    fullName: "Grace Hopper",
    companyName: "Compilers Ltd",
    workEmail: "grace@compilers.example",
    useCase: "Legacy gateway lead.",
    country: "United States",
    expectedVolume: "900/mo",
    source: "landing",
    status: "PENDING",
    notificationStatus: "SENT",
  });
  // A beta waitlist entry. It must NEVER appear in the enquiry list, and the
  // waitlist surface must keep seeing exactly it.
  const wl = await Quotation.create({
    fullName: "Beta Person",
    companyName: "Beta Co",
    workEmail: "beta@beta.example",
    useCase: "Wants beta access.",
    source: "waitlist",
    status: "PENDING",
    notificationStatus: "SENT",
  });
  return { waitlistId: String(wl._id) };
}

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  vi.clearAllMocks();
});

describe("admin enquiries — source scoping", () => {
  it("lists general enquiries and legacy leads, never waitlist entries", async () => {
    await seed();
    const page = await listEnquiries(PAGE);

    expect(page.total).toBe(2);
    const sources = page.items.map((i) => i.source).sort();
    expect(sources).toEqual(["contact_sales", "landing"]);
    expect(page.items.some((i) => i.source === "waitlist")).toBe(false);
    expect(page.items.some((i) => i.email === "beta@beta.example")).toBe(false);
  });

  it("surfaces the notification status so a non-delivery is visible", async () => {
    await seed();
    const page = await listEnquiries(PAGE);
    const ada = page.items.find((i) => i.email === "ada@analytical.example");
    expect(ada?.notificationStatus).toBe("SKIPPED");
  });

  it("requires an admin session before reading anything", async () => {
    await seed();
    await listEnquiries(PAGE);
    expect(assertConsoleAdmin).toHaveBeenCalled();
  });

  it("leaves the waitlist surface seeing exactly its own entry", async () => {
    await seed();
    const wl = await listWaitlist(PAGE);
    expect(wl.total).toBe(1);
    expect(wl.items[0]?.email).toBe("beta@beta.example");
  });

  it("does not change the waitlist count when enquiries are added", async () => {
    await seed();
    const before = await listWaitlist(PAGE);
    await Quotation.create({
      fullName: "Another Enquirer",
      companyName: "Elsewhere",
      workEmail: "x@elsewhere.example",
      useCase: "More questions.",
      source: "contact_sales",
      status: "PENDING",
      notificationStatus: "SKIPPED",
    });
    const after = await listWaitlist(PAGE);
    expect(after.total).toBe(before.total);
  });
});

describe("admin enquiries — filtering", () => {
  it("searches name, email and company", async () => {
    await seed();
    expect((await listEnquiries(PAGE, { q: "Analytical" })).total).toBe(1);
    expect((await listEnquiries(PAGE, { q: "grace@" })).total).toBe(1);
    expect((await listEnquiries(PAGE, { q: "Lovelace" })).total).toBe(1);
    expect((await listEnquiries(PAGE, { q: "nobody" })).total).toBe(0);
  });

  it("cannot be steered at the waitlist via the source filter", async () => {
    await seed();
    const page = await listEnquiries(PAGE, { source: "waitlist" });
    expect(page.items.some((i) => i.source === "waitlist")).toBe(false);
  });

  it("treats a regex-looking search as literal text", async () => {
    await seed();
    // Would match everything if interpolated unescaped.
    const page = await listEnquiries(PAGE, { q: ".*" });
    expect(page.total).toBe(0);
  });

  it("ignores an unknown status instead of returning everything", async () => {
    await seed();
    const page = await listEnquiries(PAGE, { status: "NOT_A_STATUS" });
    expect(page.total).toBe(2);
  });
});

describe("admin enquiries — detail access", () => {
  it("returns the message and audits the view", async () => {
    await seed();
    const page = await listEnquiries(PAGE);
    const id = page.items.find((i) => i.source === "contact_sales")!.id;

    const detail = await getEnquiry(id);
    expect(detail?.message).toContain("invoices going missing");
    expect(detail?.notificationError).toBe("no_recipient_configured");

    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enquiry.detail.view",
        targetType: "quotation",
        targetId: id,
      }),
    );
  });

  it("writes no enquiry content into the audit row", async () => {
    await seed();
    const page = await listEnquiries(PAGE);
    const id = page.items[0]!.id;
    await getEnquiry(id);
    const row = JSON.stringify(recordAdminAction.mock.calls[0]?.[0] ?? {});
    expect(row).not.toContain("@analytical.example");
    expect(row).not.toContain("invoices going missing");
    expect(row).not.toContain("Lovelace");
  });

  it("refuses a waitlist id through this route (no cross-surface IDOR)", async () => {
    const { waitlistId } = await seed();
    expect(await getEnquiry(waitlistId)).toBeNull();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before touching Mongo", async () => {
    await seed();
    for (const bad of ["", "abc", "../../etc", "1".repeat(25), "zzzz"]) {
      expect(await getEnquiry(bad)).toBeNull();
    }
  });

  it("returns null for a well-formed id that does not exist", async () => {
    await seed();
    expect(await getEnquiry("0".repeat(24))).toBeNull();
  });

  it("requires an admin session before reading a detail", async () => {
    await seed();
    await getEnquiry("0".repeat(24));
    expect(assertConsoleAdmin).toHaveBeenCalled();
  });
});
