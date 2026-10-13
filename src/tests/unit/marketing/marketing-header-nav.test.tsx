import { describe, expect, it, vi, beforeEach } from "vitest";

import { BrandNav } from "@/components/marketing/brand-nav";
import { SiteHeader } from "@/components/marketing/home/site-header";
import { renderWithUser, screen, within } from "@/tests/utils/render";

/**
 * The two marketing headers, and the two ways they failed a visitor.
 *
 * 1. NO WAY IN. `947ea26` swapped the landing header's Sign in / signup pair
 *    for "See the product" + "Join the beta"; removing the beta CTA then left
 *    the header with no route into the product at all. The only /login link
 *    left on the page sat in the footer — 16,268px down on a 390px viewport.
 *    `SiteHeader` is shared chrome (/ and /pricing both render it), so the
 *    regression shipped on two routes at once. The guard below is deliberately
 *    about PLACEMENT, not mere presence: a /login link that lives inside the
 *    `hidden md:flex` nav, or only inside the mobile panel, reproduces the
 *    same bug while still being "in the header".
 *
 * 2. NO WAY TO THE NAV. Both headers keep their links in a `hidden md:flex`
 *    container, so below 768px the links were not cramped — they were gone,
 *    with nothing to reveal them. `MobileNav` is the shared disclosure; these
 *    tests pin its ARIA contract and its three closing behaviours, because an
 *    expander that cannot be closed with the keyboard is its own trap.
 *
 * jsdom applies no media queries, so breakpoint behaviour is asserted
 * structurally (which container a control sits in) and the real rendered
 * widths are covered by the browser pass at 390/768/1280/1440px.
 *
 * `usePathname` is mocked through a mutable binding so a test can simulate a
 * client navigation by re-rendering with a different value.
 */

let pathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

/** Classes that remove an element below the `md` breakpoint. */
const BREAKPOINT_HIDDEN = /(^|\s)(hidden|md:hidden)(\s|$)/;

/**
 * Walks from an element up to its <header>, returning the first ancestor
 * (or the element itself) that CSS would hide at some width. Null means the
 * control is visible at every width.
 */
function breakpointHiddenAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    if (BREAKPOINT_HIDDEN.test(node.className || "")) return node;
    if (node.tagName === "HEADER") return null;
    node = node.parentElement;
  }
  return null;
}

function signInLink(): HTMLAnchorElement {
  const header = screen.getByRole("banner");
  const links = within(header)
    .getAllByRole("link")
    .filter((a) => /sign in/i.test(a.textContent ?? ""));
  expect(
    links,
    "the header must offer exactly one Sign in link",
  ).toHaveLength(1);
  return links[0] as HTMLAnchorElement;
}

describe.each([
  { name: "SiteHeader (landing, /pricing)", Header: SiteHeader, labels: ["Product", "Use cases", "Pricing", "FAQ"] },
  { name: "BrandNav (/features, /contact, legal)", Header: BrandNav, labels: ["Features", "Pricing", "Security", "Contact"] },
])("$name", ({ Header, labels }) => {
  beforeEach(() => {
    pathname = "/";
  });

  it("offers Sign in without opening the mobile menu", () => {
    renderWithUser(<Header />);

    // The mobile panel is closed on first render — this is the exact state the
    // audit measured, and the state in which the link was missing.
    expect(
      screen.queryByRole("button", { name: /close menu/i }),
      "precondition: the mobile panel starts closed",
    ).not.toBeInTheDocument();

    const link = signInLink();
    expect(link).toHaveAttribute("href", "/login");
    expect(breakpointHiddenAncestor(link)).toBeNull();
  });

  it("keeps Sign in out of the breakpoint-hidden nav", () => {
    renderWithUser(<Header />);
    const link = signInLink();

    // A /login link nested in the desktop-only nav, or in the mobile-only
    // panel, is the regression wearing a different hat.
    const hiddenContainers = Array.from(
      screen.getByRole("banner").querySelectorAll<HTMLElement>("*"),
    ).filter((n) => BREAKPOINT_HIDDEN.test(n.className || ""));
    expect(hiddenContainers.length).toBeGreaterThan(0); // nav + mobile wrapper
    for (const container of hiddenContainers) {
      expect(container.contains(link)).toBe(false);
    }
  });

  it("exposes the mobile menu as a labelled, collapsed disclosure", () => {
    renderWithUser(<Header />);

    const trigger = screen.getByRole("button", { name: /open menu/i });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    // Closed means ABSENT, not merely styled away: a `hidden` panel can still
    // hand its links to the tab order.
    expect(document.getElementById(panelId as string)).toBeNull();
  });

  it("reveals every nav link when opened, and associates the panel", async () => {
    const { user } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAccessibleName(/close menu/i);

    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") as string,
    );
    expect(panel).not.toBeNull();

    const nav = within(panel as HTMLElement).getByRole("navigation");
    for (const label of labels) {
      expect(
        within(nav).getByRole("link", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toHaveFocus();
  });

  it("is reachable and operable from the keyboard alone", async () => {
    const { user } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") as string,
    ) as HTMLElement;
    // The first panel link is the next thing in the tab order, because the
    // panel is a sibling that follows the trigger in document order.
    await user.tab();
    expect(within(panel).getAllByRole("link")[0]).toHaveFocus();
  });

  it("closes when a panel link is activated", async () => {
    const { user } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    await user.click(trigger);
    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") as string,
    ) as HTMLElement;

    // Capture-phase preventDefault: BrandNav's panel links are real routes,
    // and jsdom logs "Not implemented: navigation" when one is followed.
    // Propagation is untouched, so the component's own onClick still runs.
    const swallow = (e: Event) => e.preventDefault();
    document.addEventListener("click", swallow, true);
    try {
      await user.click(within(panel).getAllByRole("link")[0]);
    } finally {
      document.removeEventListener("click", swallow, true);
    }

    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on navigation rather than hanging over the next page", async () => {
    const { user, rerender } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The marketing layout stays mounted across a soft navigation, so the
    // header does not remount and the panel would otherwise stay open.
    pathname = "/pricing";
    rerender(<Header />);

    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("stays closed when the user returns to the route it was opened on", async () => {
    const { user, rerender } = renderWithUser(<Header />);
    const trigger = screen.getByRole("button", { name: /open menu/i });

    await user.click(trigger);
    pathname = "/pricing";
    rerender(<Header />);
    // Back button, or any return to the original route, while the header has
    // never unmounted. Comparing the stored route against the current one
    // instead of clearing it would pop the panel open again right here.
    pathname = "/";
    rerender(<Header />);

    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the desktop nav untouched while the panel is closed", () => {
    renderWithUser(<Header />);
    // Exactly one "Pricing" when closed (the desktop nav's), two when open.
    expect(screen.getAllByRole("link", { name: "Pricing" })).toHaveLength(1);
  });
});

describe("SiteHeader actions", () => {
  beforeEach(() => {
    pathname = "/";
  });

  it("keeps the product CTA reachable on a phone, via the panel", async () => {
    const { user } = renderWithUser(<SiteHeader />);

    // The bar CTA is `sm:inline-flex`, so it is absent below 640px; the panel
    // carries a copy so the primary CTA never disappears entirely.
    const barCta = screen.getByRole("link", { name: /see the product/i });
    expect(barCta).toHaveAttribute("href", "/#demo");
    expect(barCta.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(barCta.className).toMatch(/sm:inline-flex/);

    await user.click(screen.getByRole("button", { name: /open menu/i }));

    const ctas = screen
      .getAllByRole("link", { name: /see the product/i })
      .filter((a) => a.getAttribute("href") === "/#demo");
    expect(ctas).toHaveLength(2);
  });

  it("uses root-relative nav hrefs, because /pricing renders this header too", async () => {
    const { user } = renderWithUser(<SiteHeader />);
    await user.click(screen.getByRole("button", { name: /open menu/i }));

    for (const a of screen.getAllByRole("link")) {
      const href = a.getAttribute("href") ?? "";
      expect(
        href.startsWith("#"),
        `bare fragment "${href}" is dead on /pricing`,
      ).toBe(false);
    }
  });
});
