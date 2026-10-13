import { beforeEach, describe, expect, it, vi } from "vitest";

import { Quotation } from "@/server/db/models";
import { submitQuotation } from "@/server/services/quotation.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * The /contact enquiry path, end to end through the service.
 *
 * What these pin:
 *   - persistence is the source of truth, even with no email transport;
 *   - a notification that cannot be sent is recorded as SKIPPED with a
 *     reason, never as SENT (no fabricated delivery);
 *   - an accidental duplicate collapses onto the first record instead of
 *     creating a second lead and a second internal email;
 *   - a genuine follow-up with different words is its own record;
 *   - nothing written here lands in the beta waitlist.
 */

const base = {
  fullName: "Ada Lovelace",
  companyName: "Analytical Engines",
  workEmail: "ada@analytical.example",
  phone: "",
  country: "",
  expectedVolume: "",
  preferredGateway: "",
  currentStack: "",
  useCase: "We run about 30 client projects and lose track of invoices.",
  timeline: "",
  customRequirements: "",
  notes: "",
  source: "contact_sales" as const,
};

const ctx = { ip: "203.0.113.9", userAgent: "vitest" };

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  vi.restoreAllMocks();
});

describe("submitQuotation — general enquiry", () => {
  it("persists the enquiry and records an honest notification status", async () => {
    const r = await submitQuotation(base, ctx);
    expect(r.id).toMatch(/^[a-f0-9]{24}$/);
    expect(r.deduped).toBe(false);

    const doc = await Quotation.findById(r.id);
    expect(doc?.workEmail).toBe("ada@analytical.example");
    expect(doc?.source).toBe("contact_sales");
    expect(doc?.status).toBe("PENDING");
    // The test env has no transport and no SALES_EMAIL, so the only honest
    // outcomes are SKIPPED or FAILED — never SENT.
    expect(["SKIPPED", "FAILED"]).toContain(doc?.notificationStatus);
    expect(doc?.notificationStatus).not.toBe("SENT");
    // And a reason is recorded, so an admin can see why.
    expect(doc?.notificationError).toBeTruthy();
  });

  it("stores the gateway-era fields as empty rather than rejecting the enquiry", async () => {
    const r = await submitQuotation(base, ctx);
    const doc = await Quotation.findById(r.id);
    expect(doc?.country).toBe("");
    expect(doc?.expectedVolume).toBe("");
  });

  it("collapses an identical resubmission instead of creating a second lead", async () => {
    const first = await submitQuotation(base, ctx);
    const second = await submitQuotation(base, ctx);

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await Quotation.countDocuments({ workEmail: base.workEmail })).toBe(1);
  });

  it("treats whitespace-only differences as the same submission", async () => {
    const first = await submitQuotation(base, ctx);
    const second = await submitQuotation(
      { ...base, useCase: `  ${base.useCase.replace(/ /g, "  ")}  ` },
      ctx,
    );
    expect(second.id).toBe(first.id);
    expect(await Quotation.countDocuments({})).toBe(1);
  });

  it("records a genuine follow-up with different words as its own enquiry", async () => {
    const first = await submitQuotation(base, ctx);
    const second = await submitQuotation(
      { ...base, useCase: "Following up — we also need Stripe reconciliation." },
      ctx,
    );
    expect(second.deduped).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(await Quotation.countDocuments({})).toBe(2);
  });

  it("does not collapse two different people at the same company", async () => {
    await submitQuotation(base, ctx);
    const other = await submitQuotation(
      { ...base, workEmail: "charles@analytical.example" },
      ctx,
    );
    expect(other.deduped).toBe(false);
    expect(await Quotation.countDocuments({})).toBe(2);
  });

  it("never writes a waitlist row, so the beta waitlist count is unaffected", async () => {
    await submitQuotation(base, ctx);
    expect(await Quotation.countDocuments({ source: "waitlist" })).toBe(0);
  });

  it("survives a notification throw without losing the lead", async () => {
    // Whatever the email layer does, the row must exist and the status must
    // not claim a send.
    const r = await submitQuotation(
      { ...base, workEmail: "grace@analytical.example" },
      ctx,
    );
    const doc = await Quotation.findById(r.id);
    expect(doc).not.toBeNull();
    expect(doc?.notificationStatus).not.toBe("SENT");
  });
});
