import { describe, expect, it } from "vitest";

import DpaPage from "@/app/dpa/page";
import PrivacyPage from "@/app/privacy/page";
import { CLARITY_TRACKED_PATHS } from "@/lib/analytics/clarity";
import { renderWithUser, screen } from "@/tests/utils/render";

/**
 * Public disclosures required by the Microsoft Clarity Terms of Use.
 *
 * ToU v5 §4.4(b) obliges us to publish two specific things before Clarity
 * collects anything, and §4.4(c)(i) fixes the relationship it must be
 * described as:
 *
 *   §4.4(b) "Your privacy notice will disclose that third parties such as
 *            Microsoft may collect Personal Data from individuals visiting
 *            Your websites … You will disclose in your privacy notice the
 *            fact that Microsoft collects or receives Personal Data from you
 *            to provide Microsoft Advertising, and provide a link to the
 *            Microsoft Privacy Statements: https://privacy.microsoft.com/…"
 *   §4.4(c)(i) "You and Microsoft are independent Controllers … neither of
 *            them are a 'processor,' 'service provider,' or equivalent
 *            status."
 *
 * These are contractual obligations, not copy preferences, so they are
 * pinned here. The page must also not describe Microsoft as a sub-processor,
 * which is the specific error §4.4(c)(i) rules out and which the
 * sub-processor table would otherwise imply ("they process personal
 * information only under our instructions").
 *
 * Rendering the pages rather than grepping their source is deliberate: what
 * matters is what a visitor actually reads.
 */

const MS_PRIVACY_STATEMENT = "https://privacy.microsoft.com/en-us/privacystatement";

function privacyText(): string {
  const { container } = renderWithUser(<PrivacyPage />);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function dpaText(): string {
  const { container } = renderWithUser(<DpaPage />);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

describe("privacy policy — Clarity disclosures (ToU §4.4)", () => {
  it("discloses that third parties such as Microsoft may collect from visitors", () => {
    expect(privacyText()).toMatch(
      /third parties such as Microsoft may collect personal information from visitors/i,
    );
  });

  it("names Microsoft Clarity and scopes it to the public marketing pages", () => {
    const text = privacyText();
    expect(text).toMatch(/Microsoft Clarity/);
    expect(text).toMatch(/public marketing pages/i);
  });

  it("discloses the Microsoft Advertising purpose", () => {
    // §4.4(b) requires this specific fact, not a generic "we use analytics".
    expect(privacyText()).toMatch(/Microsoft Advertising/);
  });

  it("links to the Microsoft Privacy Statement", () => {
    renderWithUser(<PrivacyPage />);
    const link = screen.getByRole("link", { name: /Microsoft Privacy Statement/i });
    expect(link).toHaveAttribute("href", MS_PRIVACY_STATEMENT);
    // External destination: must not leak the referrer or be prefetched.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("describes Microsoft as an independent controller", () => {
    expect(privacyText()).toMatch(/independent controller/i);
  });

  it("does not describe Microsoft as our processor or sub-processor", () => {
    const text = privacyText();
    expect(text).toMatch(
      /Microsoft is not acting as our processor, service provider, or sub-processor/i,
    );
    // The sub-processor table promises those providers act "only under our
    // instructions" — which is exactly what Microsoft does NOT do.
    expect(text).toMatch(/Microsoft Clarity is deliberately not in this table/i);
  });

  it("no longer claims we use no third-party analytics or advertising cookies", () => {
    // Both statements were true before Clarity was integrated and would
    // become false the moment it is switched on.
    const text = privacyText();
    expect(text).not.toMatch(
      /We do not use advertising cookies, cross-site trackers, or third-party analytics/i,
    );
    expect(text).not.toMatch(
      /We do not share personal information with advertising networks/i,
    );
  });

  it("keeps the claims that are still true", () => {
    const text = privacyText();
    expect(text).toMatch(/We do not sell personal information/i);
    expect(text).toMatch(/we do not use personal information to train AI/i);
  });

  it("states the exclusions that make the disclosure accurate", () => {
    const text = privacyText();
    // Every excluded surface class the allow-list actually enforces.
    for (const surface of [
      /sign-in/i,
      /password reset/i,
      /payment or consent pages/i,
      /signed-in application/i,
      /administration console/i,
    ]) {
      expect(text).toMatch(surface);
    }
    // And that inputs are masked before anything is sent.
    expect(text).toMatch(/masked before anything is sent/i);
  });

  it("promises no custom identifiers, matching what the code does", () => {
    expect(privacyText()).toMatch(
      /do not send Microsoft a user identifier, an email address, a name, or any custom identifier or event/i,
    );
  });

  it("tells visitors how to opt out", () => {
    expect(privacyText()).toMatch(/clarity\.ms/);
  });
});

describe("DPA — Clarity is outside its scope", () => {
  it("carves website analytics out of the sub-processor commitment", () => {
    const text = dpaText();
    expect(text).toMatch(
      /independent controller rather than as our sub-processor/i,
    );
    expect(text).toMatch(/outside the scope of a DPA/i);
  });

  it("still describes TraceTxn itself as the processor for Client Data", () => {
    // The carve-out must not disturb the DPA's actual subject matter.
    expect(dpaText()).toMatch(
      /you act as the controller and TraceTxn acts as the processor for Client Data/i,
    );
  });

  it("links to the privacy policy's analytics section", () => {
    renderWithUser(<DpaPage />);
    const links = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(links).toContain("/privacy#website-analytics");
  });
});

describe("disclosure and code agree on scope", () => {
  /**
   * The point of failure this guards: someone widens
   * CLARITY_TRACKED_PATHS and the published privacy policy silently
   * becomes a false statement. The allow-list is the contract with the
   * reader as much as with the browser.
   */
  it("the allow-list is still exactly the ten public marketing routes", () => {
    expect([...CLARITY_TRACKED_PATHS]).toEqual([
      "/",
      "/features",
      "/pricing",
      "/security",
      "/contact",
      "/terms",
      "/privacy",
      "/refunds",
      "/dpa",
      "/waitlist",
    ]);
  });

  it("contains no authenticated, payment, consent or auth route", () => {
    for (const path of CLARITY_TRACKED_PATHS) {
      expect(path).not.toMatch(/^\/(app|admin|pay|consent|login|signup)/);
      expect(path).not.toMatch(/reset-password|forgot-password|join|activate/);
    }
  });

  it("the privacy policy is itself a tracked page, so the disclosure is visible where it applies", () => {
    expect([...CLARITY_TRACKED_PATHS]).toContain("/privacy");
  });
});
