import { describe, expect, it } from "vitest";

import {
  GENERAL_ENQUIRY_SOURCE,
  contactEnquirySchema,
  quotationSchema,
} from "@/lib/validation/quotation";

/**
 * The /contact general enquiry shares `quotationSchema` with the gateway-era
 * lead flows, so the schema carries two shapes keyed on `source`. These tests
 * pin both halves of that bargain:
 *
 *   - a general enquiry does NOT have to declare a country or a payment
 *     volume (the point of the change), and
 *   - every other source still must (the thing that must not have been
 *     weakened on the way).
 */

const enquiry = {
  fullName: "Ada Lovelace",
  companyName: "Analytical Engines",
  workEmail: "ada@analytical.example",
  useCase: "We run about 30 client projects and lose track of invoices.",
  source: GENERAL_ENQUIRY_SOURCE,
};

describe("quotationSchema — general enquiry relaxation", () => {
  it("accepts a contact_sales enquiry with no country or expectedVolume", () => {
    const parsed = quotationSchema.parse(enquiry);
    expect(parsed.source).toBe("contact_sales");
    // Defaulted to empty strings, not undefined, so the stored document
    // keeps a consistent shape.
    expect(parsed.country).toBe("");
    expect(parsed.expectedVolume).toBe("");
  });

  it.each(["landing", "email_requirements"] as const)(
    "still REQUIRES country and expectedVolume for source=%s",
    (source) => {
      const r = quotationSchema.safeParse({ ...enquiry, source });
      expect(r.success).toBe(false);
      if (r.success) return;
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("country");
      expect(paths).toContain("expectedVolume");
    },
  );

  it("accepts a legacy source once country and expectedVolume are given", () => {
    const parsed = quotationSchema.parse({
      ...enquiry,
      source: "landing",
      country: "United Kingdom",
      expectedVolume: "500/mo",
    });
    expect(parsed.country).toBe("United Kingdom");
  });

  it("REFUSES source=waitlist on public input, so a lead cannot be injected into the beta waitlist", () => {
    // `console/services/provision.ts` provisions an Org + owner User from a
    // `source: "waitlist"` quotation. /api/quotations is unauthenticated, so
    // accepting that value would be a privilege-escalation path.
    const r = quotationSchema.safeParse({ ...enquiry, source: "waitlist" });
    expect(r.success).toBe(false);
  });

  it("rejects a disposable email address", () => {
    const r = quotationSchema.safeParse({
      ...enquiry,
      workEmail: "throwaway@mailinator.com",
    });
    expect(r.success).toBe(false);
  });

  it("bounds the free-text message", () => {
    const r = quotationSchema.safeParse({
      ...enquiry,
      useCase: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
  });

  it("requires a real message, not two characters", () => {
    expect(quotationSchema.safeParse({ ...enquiry, useCase: "hi" }).success).toBe(
      false,
    );
  });
});

describe("contactEnquirySchema — the narrow public shape", () => {
  const body = {
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    workEmail: "ada@analytical.example",
    message: "We run about 30 client projects and lose track of invoices.",
  };

  it("accepts the four fields the form collects", () => {
    expect(contactEnquirySchema.parse(body).workEmail).toBe(
      "ada@analytical.example",
    );
  });

  it("strips anything else, so a crafted body cannot set source or status", () => {
    const parsed = contactEnquirySchema.parse({
      ...body,
      source: "waitlist",
      status: "QUALIFIED",
      grantedAt: new Date().toISOString(),
    }) as Record<string, unknown>;
    expect(parsed.source).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.grantedAt).toBeUndefined();
  });

  it("rejects a disposable address and a too-short message", () => {
    expect(
      contactEnquirySchema.safeParse({ ...body, workEmail: "a@mailinator.com" })
        .success,
    ).toBe(false);
    expect(
      contactEnquirySchema.safeParse({ ...body, message: "hi" }).success,
    ).toBe(false);
  });

  it("normalises the email to lower case and trims", () => {
    const parsed = contactEnquirySchema.parse({
      ...body,
      workEmail: "  Ada@Analytical.Example  ",
    });
    expect(parsed.workEmail).toBe("ada@analytical.example");
  });
});
