import { describe, expect, it, vi } from "vitest";

import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * `/waitlist` is the only Clarity-tracked route that collects personal data,
 * so it is the only marketing page where masking does real work.
 *
 * The regression this pins: the success state is an EARLY RETURN that echoes
 * the submitted email address back into a plain `<span>`. Clarity's "input
 * values are masked in every mode" guarantee does not reach a text node, and
 * the `data-clarity-mask` on the `<form>` is not in the tree at that point — so
 * for a while the one field the form echoes back was the one field nothing
 * protected. Under Clarity's Relaxed mode that address uploads verbatim.
 *
 * Both states are asserted, because the leak was in the branch nobody looked
 * at.
 */

const APPLICANT_EMAIL = "ada@example.test";

function okResponse() {
  return new Response(JSON.stringify({ ok: true, data: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Every ancestor-or-self mask attribute that Clarity would inherit from. */
function isWithinMaskedRegion(node: Element | null): boolean {
  return Boolean(node?.closest('[data-clarity-mask="true"]'));
}

describe("WaitlistForm — session-recording masking", () => {
  it("masks every field in the form state", () => {
    renderWithUser(<WaitlistForm turnstileSiteKey={null} />);

    const form = document.querySelector("form");
    expect(form).toHaveAttribute("data-clarity-mask", "true");

    // The two native <select>s bypass the shared Input/Textarea primitives, so
    // the region mask is their only code-side protection.
    for (const field of Array.from(
      document.querySelectorAll("input, textarea, select"),
    )) {
      expect(
        isWithinMaskedRegion(field),
        `${field.tagName.toLowerCase()}#${field.id} is not inside a masked region`,
      ).toBe(true);
    }
  });

  it("masks the submitted email echoed back on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    const { user } = renderWithUser(<WaitlistForm turnstileSiteKey={null} />);
    await user.type(screen.getByLabelText(/full name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/work email/i), APPLICANT_EMAIL);
    await user.click(screen.getByRole("button", { name: /request|apply|join/i }));

    // The success card replaces the form entirely.
    const echoed = await screen.findByText(APPLICANT_EMAIL);
    expect(document.querySelector("form")).toBeNull();

    expect(
      isWithinMaskedRegion(echoed),
      "the submitted email is rendered outside any masked region — Clarity would upload it",
    ).toBe(true);
  });

  it("leaves no unmasked node containing the address anywhere on the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    const { user } = renderWithUser(<WaitlistForm turnstileSiteKey={null} />);
    await user.type(screen.getByLabelText(/full name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/work email/i), APPLICANT_EMAIL);
    await user.click(screen.getByRole("button", { name: /request|apply|join/i }));
    await waitFor(() => expect(document.querySelector("form")).toBeNull());

    // Belt and braces: walk the whole tree rather than trusting one node.
    const leaked = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        el.textContent?.includes(APPLICANT_EMAIL) &&
        el.children.length === 0 &&
        !isWithinMaskedRegion(el),
    );
    expect(
      leaked.map((el) => el.outerHTML),
      "found unmasked DOM carrying the applicant's email",
    ).toEqual([]);
  });
});
