import { beforeEach, describe, expect, it } from "vitest";

import { BetaApplication, Quotation } from "@/server/db/models";
import {
  ENQUIRY_RETENTION_DAYS,
  purgeOldEnquiries,
} from "@/server/services/retention.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * The 180-day general-enquiry retention promise on /privacy.
 *
 * The `quotations` collection is shared, so the dangerous failure mode is not
 * "forgot to delete" — it is "deleted something it had no business touching".
 * These tests pin both directions:
 *
 *   - a contact_sales enquiry past the window is gone;
 *   - one inside the window, and one exactly at the boundary, are kept;
 *   - waitlist entries of ANY age survive, because provisioning and the
 *     admin dashboard count depend on them;
 *   - legacy gateway leads of any age survive, because nobody agreed to
 *     delete those;
 *   - beta applications are in another collection and are unaffected.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00.000Z");

/**
 * Seed a quotation with a back-dated `createdAt`.
 *
 * The back-date goes through the raw driver on purpose. Under
 * `timestamps: true` Mongoose marks `createdAt` immutable, so a
 * `Model.updateOne({ $set: { createdAt } })` reports `modifiedCount: 1` and
 * silently leaves the original value — which would make every assertion here
 * pass for the wrong reason (nothing is old, so nothing is deleted).
 */
type QuotationSource =
  | "landing"
  | "contact_sales"
  | "email_requirements"
  | "waitlist";

async function seedQuotation(
  source: QuotationSource,
  ageDays: number,
  email: string,
): Promise<string> {
  const createdAt = new Date(NOW.getTime() - ageDays * DAY_MS);
  const doc = await Quotation.create({
    fullName: "Seed Person",
    companyName: "Seed Co",
    workEmail: email,
    useCase: "Seeded for the retention test.",
    source,
    status: "PENDING",
    notificationStatus: "SKIPPED",
  });
  await Quotation.collection.updateOne(
    { _id: doc._id },
    { $set: { createdAt } },
  );
  const check = await Quotation.collection.findOne({ _id: doc._id });
  // Guard the fixture itself: if the back-date silently fails again, fail
  // here rather than reporting a green retention test.
  if ((check as { createdAt?: Date })?.createdAt?.getTime() !== createdAt.getTime()) {
    throw new Error("fixture: createdAt back-date did not persist");
  }
  return String(doc._id);
}

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

describe("purgeOldEnquiries", () => {
  it("uses the 180-day window the privacy policy states", () => {
    expect(ENQUIRY_RETENTION_DAYS).toBe(180);
  });

  it("deletes a general enquiry older than the window", async () => {
    const id = await seedQuotation("contact_sales", 200, "old@example.test");
    const r = await purgeOldEnquiries(NOW);

    expect(r.deleted).toBe(1);
    expect(await Quotation.findById(id)).toBeNull();
    // The cutoff is surfaced so an operator can check the window.
    expect(r.cutoff.toISOString()).toBe(
      new Date(NOW.getTime() - 180 * DAY_MS).toISOString(),
    );
  });

  it("keeps a general enquiry inside the window", async () => {
    const id = await seedQuotation("contact_sales", 179, "new@example.test");
    const r = await purgeOldEnquiries(NOW);

    expect(r.deleted).toBe(0);
    expect(await Quotation.findById(id)).not.toBeNull();
  });

  it("keeps one exactly at the boundary (the filter is strictly older-than)", async () => {
    const id = await seedQuotation("contact_sales", 180, "edge@example.test");
    await purgeOldEnquiries(NOW);
    expect(await Quotation.findById(id)).not.toBeNull();
  });

  it("NEVER deletes a waitlist entry, however old", async () => {
    const wl = await seedQuotation("waitlist", 900, "beta@example.test");
    const enq = await seedQuotation("contact_sales", 900, "old@example.test");

    const r = await purgeOldEnquiries(NOW);

    expect(r.deleted).toBe(1);
    expect(await Quotation.findById(enq)).toBeNull();
    expect(await Quotation.findById(wl)).not.toBeNull();
    // The surface the admin dashboard counts is intact.
    expect(await Quotation.countDocuments({ source: "waitlist" })).toBe(1);
  });

  it("NEVER deletes legacy gateway leads, however old", async () => {
    const landing = await seedQuotation("landing", 900, "a@example.test");
    const reqs = await seedQuotation(
      "email_requirements",
      900,
      "b@example.test",
    );

    await purgeOldEnquiries(NOW);

    expect(await Quotation.findById(landing)).not.toBeNull();
    expect(await Quotation.findById(reqs)).not.toBeNull();
  });

  it("does not touch beta applications", async () => {
    await BetaApplication.create({
      fullName: "Beta Person",
      email: "beta-app@example.test",
      userType: "FREELANCER",
      status: "PENDING",
    });
    await seedQuotation("contact_sales", 900, "old@example.test");

    await purgeOldEnquiries(NOW);

    expect(await BetaApplication.countDocuments({})).toBe(1);
  });

  it("is idempotent — a second run deletes nothing new", async () => {
    await seedQuotation("contact_sales", 200, "old@example.test");
    expect((await purgeOldEnquiries(NOW)).deleted).toBe(1);
    expect((await purgeOldEnquiries(NOW)).deleted).toBe(0);
  });

  it("deletes only the aged rows when ages are mixed", async () => {
    await seedQuotation("contact_sales", 400, "x1@example.test");
    await seedQuotation("contact_sales", 181, "x2@example.test");
    const keep1 = await seedQuotation("contact_sales", 10, "y1@example.test");
    const keep2 = await seedQuotation("contact_sales", 0, "y2@example.test");

    const r = await purgeOldEnquiries(NOW);

    expect(r.deleted).toBe(2);
    expect(await Quotation.countDocuments({ source: "contact_sales" })).toBe(2);
    expect(await Quotation.findById(keep1)).not.toBeNull();
    expect(await Quotation.findById(keep2)).not.toBeNull();
  });
});
