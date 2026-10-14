import { describe, expect, it, vi, beforeEach } from "vitest";

import { renderWithUser, screen, within } from "@/tests/utils/render";

/**
 * Sign in, asserted against the ACTUAL landing page.
 *
 * `marketing-header-nav.test.tsx` imports SiteHeader and BrandNav directly,
 * which leaves one hole: it passes whatever `src/app/page.tsx` happens to
 * render. If the route were switched to another header — or to a copy of one
 * without the Sign in link — every test there would stay green while / shipped
 * the dead end again. This file closes that hole by rendering the route's own
 * default export and querying the result.
 *
 * It is deliberately NOT source matching. The assertions run against the
 * rendered tree: the banner landmark the page actually produced, the link's
 * resolved href, and the ancestor chain between the link and that banner.
 *
 * Breakpoints: jsdom applies no media queries, so "visible at every width" is
 * asserted structurally — no ancestor between the link and the header carries
 * a class that removes it at a breakpoint, and the link is not inside the
 * mobile panel. The rendered widths (390/768/1280/1440px) are measured in the
 * browser pass, which reads real bounding boxes.
 *
 * ── Why this file exists at all ──────────────────────────────────────────
 *
 * The regression was reported as live AFTER it had been fixed and verified
 * locally. The cause was not the component: the deployed revision predated
 * the fix. A unit test cannot catch deploy drift — but it can at least pin
 * that the route, not just the component, carries the link.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

/** Classes that remove an element below (or above) a breakpoint. */
const BREAKPOINT_HIDDEN = /(^|\s)(hidden|md:hidden|sm:hidden|lg:hidden)(\s|$)/;

async function renderLandingPage() {
  const { default: LandingPage } = await import("@/app/page");
  return renderWithUser(<LandingPage />);
}

describe("/ (the landing page route) — Sign in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a header landmark", async () => {
    await renderLandingPage();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("puts exactly one Sign in link to /login in that header", async () => {
    await renderLandingPage();

    const header = screen.getByRole("banner");
    const signIn = within(header)
      .getAllByRole("link")
      .filter((a) => /^sign in$/i.test((a.textContent ?? "").trim()));

    expect(
      signIn,
      "the landing page's header must offer exactly one Sign in link — none is the original bug, two is a duplicated workaround",
    ).toHaveLength(1);
    expect(signIn[0]).toHaveAttribute("href", "/login");
  });

  it("keeps that link out of every breakpoint-hidden container", async () => {
    await renderLandingPage();

    const header = screen.getByRole("banner");
    const link = within(header)
      .getAllByRole("link")
      .find((a) => /^sign in$/i.test((a.textContent ?? "").trim())) as HTMLElement;

    // Walk from the link to the header: nothing in between may hide it.
    const offenders: string[] = [];
    let node: HTMLElement | null = link;
    while (node && node !== header) {
      if (BREAKPOINT_HIDDEN.test(node.className || "")) {
        offenders.push(`${node.tagName}.${node.className}`);
      }
      node = node.parentElement;
    }
    expect(
      offenders,
      "a Sign in link inside a breakpoint-hidden container is the same bug wearing a different hat",
    ).toEqual([]);
  });

  it("does not hide Sign in behind the mobile menu", async () => {
    await renderLandingPage();

    const header = screen.getByRole("banner");
    const trigger = within(header).getByRole("button", { name: /open menu/i });
    const panelId = trigger.getAttribute("aria-controls");

    // The panel is absent while closed, so the link cannot be inside it; this
    // asserts the link is reachable in exactly the state a visitor lands in.
    expect(document.getElementById(panelId as string)).toBeNull();

    const link = within(header)
      .getAllByRole("link")
      .find((a) => /^sign in$/i.test((a.textContent ?? "").trim())) as HTMLElement;
    expect(link).toBeInTheDocument();

    // And the mobile trigger must not be the thing that reveals it.
    const mobileWrapper = trigger.parentElement as HTMLElement;
    expect(mobileWrapper.contains(link)).toBe(false);
  });

  it("still carries the See the product CTA", async () => {
    await renderLandingPage();

    const header = screen.getByRole("banner");
    const ctas = within(header)
      .getAllByRole("link")
      .filter((a) => /see the product/i.test(a.textContent ?? ""));

    expect(ctas.length).toBeGreaterThanOrEqual(1);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute("href", "/#demo");
    }
  });

  it("leaves ?next= to /login rather than constructing one", async () => {
    await renderLandingPage();

    const header = screen.getByRole("banner");
    const link = within(header)
      .getAllByRole("link")
      .find((a) => /^sign in$/i.test((a.textContent ?? "").trim())) as HTMLElement;

    // /login reads ?next= itself and falls back to /app/dashboard; a hardcoded
    // next here would pin every visitor to one destination.
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("keeps the header sticky, so Sign in survives scrolling", async () => {
    await renderLandingPage();
    const header = screen.getByRole("banner");
    const classes = (header.className || "").split(/\s+/);

    // This is a RENDERED assertion, not source matching: `cn` has already run
    // twMerge over the class list by the time it reaches the DOM, and that is
    // exactly where the bug lived. Adding `relative` to anchor the mobile
    // panel put it in the same tailwind-merge position group as `sticky`, so
    // the later class won and `sticky` was dropped from the output. The header
    // then scrolled away on a 16,268px page and Sign in went with it —
    // indistinguishable, to a visitor, from the link never being there.
    expect(
      classes,
      "the header must stay sticky; a position utility added later (relative/absolute/fixed) silently replaces `sticky` via twMerge",
    ).toContain("sticky");
    for (const conflicting of ["relative", "absolute", "fixed", "static"]) {
      expect(classes).not.toContain(conflicting);
    }
    expect(classes).toContain("top-0");
  });

  it("is reachable without scrolling: Sign in precedes the footer link", async () => {
    await renderLandingPage();

    const all = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/login");

    // The original bug left only the footer link, 16,268px down a phone page.
    expect(all.length).toBeGreaterThanOrEqual(1);
    const first = all[0];
    expect(
      first.closest("header"),
      "the first /login link on the page must be the header's, not the footer's",
    ).not.toBeNull();
  });
});
