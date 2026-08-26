import { describe, expect, it, vi } from "vitest";

/**
 * Claim discipline for the public SEO surfaces.
 *
 * These exist because of a real regression: commit bc04b35 emptied
 * FAQ_WITHHELD_FROM_SCHEMA after client files and links shipped, which was
 * correct for files — but the answer it un-withheld also enumerated
 * "approvals", a capability that has no model, service, route or UI. The
 * false claim went straight into the live FAQPage JSON-LD, where Google
 * ingests it as a rich result.
 *
 * The rule these tests enforce: nothing in structured data may promise a
 * capability the application cannot perform. A word landing on this denylist
 * should be deleted from the copy, not merely hidden from the schema.
 */

vi.mock("@/lib/env", () => ({
  env: {
    server: {},
    public: {
      NEXT_PUBLIC_APP_NAME: "TraceTxn",
      NEXT_PUBLIC_APP_URL: "https://tracetxn.test",
    },
  },
}));

/**
 * Capabilities the product does NOT implement. Verified against the tree:
 * there is no approvals model, service, API route or UI component; "Approve"
 * survives only as an example workflow-transition button label
 * (workflow.model.ts) and an example template display name
 * (email-template.model.ts).
 *
 * Delete an entry here the day the feature actually ships — that is the
 * signal that the claim became true, and these tests will then let it in.
 */
const UNIMPLEMENTED = [/approvals?\b/i, /e-?signature/i, /sign-?off/i];

describe("SEO claim discipline", () => {
  it("no FAQ answer emitted as JSON-LD promises an unimplemented capability", async () => {
    const { SCHEMA_FAQS } = await import(
      "@/components/marketing/home/faq-content"
    );
    expect(SCHEMA_FAQS.length).toBeGreaterThan(0);

    for (const faq of SCHEMA_FAQS) {
      for (const pattern of UNIMPLEMENTED) {
        expect(
          `${faq.q} ${faq.a}`,
          `FAQ "${faq.q}" claims something the app cannot do (${pattern})`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("every withheld question is genuinely absent from the emitted set", async () => {
    const { FAQS, SCHEMA_FAQS, FAQ_WITHHELD_FROM_SCHEMA } = await import(
      "@/components/marketing/home/faq-content"
    );
    // The mechanism must stay wired even when the withhold list is empty:
    // emitted == all visible questions minus the withheld ones, exactly.
    expect(SCHEMA_FAQS).toHaveLength(
      FAQS.length - FAQ_WITHHELD_FROM_SCHEMA.length,
    );
    for (const q of FAQ_WITHHELD_FROM_SCHEMA) {
      expect(SCHEMA_FAQS.map((f) => f.q)).not.toContain(q);
    }
  });

  it("every withheld question actually exists in the visible FAQ", async () => {
    // A typo in the withhold list would silently withhold nothing.
    const { FAQS, FAQ_WITHHELD_FROM_SCHEMA } = await import(
      "@/components/marketing/home/faq-content"
    );
    const visible = FAQS.map((f) => f.q);
    for (const q of FAQ_WITHHELD_FROM_SCHEMA) {
      expect(visible, `withheld question not found in FAQS: ${q}`).toContain(q);
    }
  });

  it("the metadata description does not promise an unimplemented capability", async () => {
    const { DESCRIPTION, SHORT_DESCRIPTION, HEADLINE, KEYWORDS } = await import(
      "@/lib/seo"
    );
    const surface = [DESCRIPTION, SHORT_DESCRIPTION, HEADLINE, ...KEYWORDS].join(
      " ",
    );
    for (const pattern of UNIMPLEMENTED) {
      expect(surface).not.toMatch(pattern);
    }
  });

  it("keeps the positioning off payment-dispute vocabulary", async () => {
    // Guards the repositioning done in 50bb148: payments, Stripe and the
    // evidence chain are REAL and may be named as capabilities — what must
    // not come back is dispute/chargeback framing as the product identity.
    const { DESCRIPTION, HEADLINE, KEYWORDS } = await import("@/lib/seo");
    const identity = [HEADLINE, DESCRIPTION, ...KEYWORDS].join(" ").toLowerCase();
    for (const term of [
      "chargeback",
      "payment operations platform",
      "dispute management",
    ]) {
      expect(identity).not.toContain(term);
    }
  });
});
