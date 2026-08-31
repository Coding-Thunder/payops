import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ClarityAnalytics } from "@/components/analytics/clarity-analytics";
import { renderWithUser } from "@/tests/utils/render";

/**
 * The Clarity gate.
 *
 * Four invariants, each with a concrete failure mode that has already bitten
 * this integration once:
 *
 *   1. NO PROJECT ID → NO SCRIPT. The kill switch. Local dev, .env.test,
 *      .env.smoke and CI all leave NEXT_PUBLIC_CLARITY_PROJECT_ID unset and
 *      must render exactly as they did before Clarity existed.
 *   2. THE SNIPPET MUST BE THE WHOLE SNIPPET. An earlier revision rendered
 *      `<Script src="…/tag/<id>">`, which returns HTTP 200 and then throws on
 *      its first line, because those bytes call `window.clarity(…)` without
 *      ever defining it. Clarity recorded nothing while still firing an
 *      advertising pixel. These tests pin the command-queue stub.
 *   3. THE ROUTE ALLOW-LIST IS ENFORCED AT RENDER, not merely declared.
 *   4. A CLIENT NAVIGATION MAY NEVER CARRY THE RECORDER INTO A DENIED ROUTE.
 *      Clarity restarts itself 250 ms after any URL change, so reacting after
 *      the fact loses a race; the crossing has to stop being a soft navigation
 *      in the first place.
 *
 * `next/script` is mocked to a <div> carrying the same props: the real
 * component hands the script to Next's runtime manager, which does not exist
 * under jsdom, so asserting on its output would assert on the mock. A <div>
 * also keeps the assertion from tripping `@next/next/no-sync-scripts`.
 */

const pathname = vi.fn<() => string | null>(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

vi.mock("next/script", () => ({
  default: ({
    id,
    strategy,
    dangerouslySetInnerHTML,
    src,
  }: {
    id?: string;
    strategy?: string;
    src?: string;
    dangerouslySetInnerHTML?: { __html: string };
  }) => (
    <div
      data-testid="next-script"
      data-id={id}
      data-strategy={strategy}
      data-src={src ?? ""}
      data-inline={dangerouslySetInnerHTML?.__html ?? ""}
    />
  ),
}));

const PROJECT_ID = "abcd1234ef";

function scripts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="next-script"]'),
  );
}

const TRACKED = [
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
];

const DENIED: ReadonlyArray<readonly [string, string]> = [
  ["/login", "password entry"],
  ["/signup", "password entry"],
  ["/forgot-password", "account enumeration surface"],
  ["/reset-password/tok", "reset token in the path"],
  ["/join/tok", "invite token in the path"],
  ["/activate", "activation token in the query"],
  ["/consent/tok", "consent token in the path"],
  ["/pay/success", "Stripe session id in the query"],
  ["/pay/cancelled", "payment surface"],
  ["/app/dashboard", "authenticated tenant data"],
  ["/app/orders/65f", "customer PII + payment links"],
  ["/app/admin/gateways", "Stripe secret key entry"],
  ["/admin", "console login: admin email + OTP"],
  ["/admin/customers/65f", "cross-tenant customer PII"],
];

describe("ClarityAnalytics", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pathname.mockReset().mockReturnValue("/");
    reload = vi.fn();
    // jsdom's location.reload is not writable, so the whole object is replaced.
    // Spelled out rather than spread: Location's accessors live on the
    // prototype, so `{...window.location}` silently loses `origin` — and the
    // interceptor compares origins.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: "https://tracetxn.test/",
        origin: "https://tracetxn.test",
        protocol: "https:",
        host: "tracetxn.test",
        hostname: "tracetxn.test",
        pathname: "/",
        search: "",
        hash: "",
        reload,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("kill switch", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["empty string", ""],
      ["whitespace only", "   "],
      ["malformed (punctuation)", "abc-123"],
      ["malformed (script injection attempt)", '"); alert(1);//'],
    ])("does not initialise Clarity (%s)", (_label, id) => {
      renderWithUser(<ClarityAnalytics projectId={id} />);
      expect(scripts()).toHaveLength(0);
    });

    it("renders nothing at all, so pages are unaffected", () => {
      const { container } = renderWithUser(
        <ClarityAnalytics projectId={undefined} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("never reloads the page when crossing routes", () => {
      const { rerender } = renderWithUser(
        <ClarityAnalytics projectId={undefined} />,
      );
      pathname.mockReturnValue("/app/dashboard");
      rerender(<ClarityAnalytics projectId={undefined} />);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe("the injected snippet", () => {
    it("ships the command-queue stub, not just the tag URL", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);

      const found = scripts();
      expect(found).toHaveLength(1);
      const inline = found[0].dataset.inline ?? "";

      // THE regression guard. The bytes at /tag/<id> call window.clarity(...)
      // and read window.clarity.q before defining either. Without this stub the
      // tag throws, clarity.js is never fetched, and nothing is ever recorded.
      expect(inline).toContain("c[a]=c[a]||function()");
      expect(inline).toContain("(c[a].q=c[a].q||[]).push(arguments)");
      // And it must still load the tag, with our project id.
      expect(inline).toContain('t.src="https://www.clarity.ms/tag/"+i');
      expect(inline).toContain(`"${PROJECT_ID}"`);
      // Never a bare src= handoff, which is what silently broke before.
      expect(found[0].dataset.src).toBe("");
    });

    it("guards against injecting a second tag", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(scripts()[0].dataset.inline).toContain(
        'if(l.getElementById("clarity-script"))return',
      );
    });

    it("is loaded after hydration under a stable de-duplication id", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(scripts()[0].dataset.id).toBe("ms-clarity");
      expect(scripts()[0].dataset.strategy).toBe("afterInteractive");
    });

    it("initialises exactly once across re-renders and tracked navigations", () => {
      const { rerender } = renderWithUser(
        <ClarityAnalytics projectId={PROJECT_ID} />,
      );
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);
      pathname.mockReturnValue("/pricing");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);
      pathname.mockReturnValue("/waitlist");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);

      expect(scripts()).toHaveLength(1);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe("route allow-list", () => {
    it.each(TRACKED)("loads on the public marketing page %s", (path) => {
      pathname.mockReturnValue(path);
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(scripts()).toHaveLength(1);
    });

    it.each(DENIED)("never loads on %s (%s)", (path) => {
      pathname.mockReturnValue(path);
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(scripts()).toHaveLength(0);
    });
  });

  /**
   * The boundary itself. Clarity proxies history.pushState and restarts 250 ms
   * after any URL change, re-walking the DOM — so the recorder must never be
   * present for a client-side navigation into a denied route. The capture-phase
   * listener stops the event before Next's <Link> handler sees it, leaving the
   * browser to perform a real document navigation.
   */
  describe("crossing out of the allow-list", () => {
    function clickLink(href: string, init: MouseEventInit = {}) {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.textContent = "go";
      document.body.appendChild(anchor);

      // Stand in for Next's <Link>: React 19 delegates to the root container,
      // so a bubble-phase listener is what the interceptor has to beat.
      const linkHandler = vi.fn();
      document.body.addEventListener("click", linkHandler);

      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      anchor.dispatchEvent(event);

      document.body.removeEventListener("click", linkHandler);
      anchor.remove();
      return { softNavigationHandlerRan: linkHandler.mock.calls.length > 0, event };
    }

    it("stops a click into a denied route from reaching the router", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      for (const [href] of DENIED) {
        const { softNavigationHandlerRan, event } = clickLink(
          `https://tracetxn.test${href}`,
        );
        expect(
          softNavigationHandlerRan,
          `${href} must not be handled by the client router`,
        ).toBe(false);
        // Not prevented: the browser's own default action IS the hard
        // navigation we want. Preventing it would strand the user.
        expect(event.defaultPrevented).toBe(false);
      }
    });

    it("leaves tracked → tracked navigations as soft navigations", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      for (const href of TRACKED) {
        expect(
          clickLink(`https://tracetxn.test${href}`).softNavigationHandlerRan,
          `${href} should stay a client navigation`,
        ).toBe(true);
      }
    });

    it("does not interfere when Clarity is not running", () => {
      // No project id → no listener → the router keeps every click.
      renderWithUser(<ClarityAnalytics projectId={undefined} />);
      expect(
        clickLink("https://tracetxn.test/login").softNavigationHandlerRan,
      ).toBe(true);
    });

    it("does not interfere on a denied page, where Clarity never loaded", () => {
      pathname.mockReturnValue("/login");
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(
        clickLink("https://tracetxn.test/app/dashboard")
          .softNavigationHandlerRan,
      ).toBe(true);
    });

    it("ignores cross-origin links, which leave the document anyway", () => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(
        clickLink("https://example.com/login").softNavigationHandlerRan,
      ).toBe(true);
    });

    it.each([
      ["ctrl-click", { ctrlKey: true }],
      ["meta-click", { metaKey: true }],
      ["shift-click", { shiftKey: true }],
      ["middle-click", { button: 1 }],
    ])("leaves %s alone — it opens its own context", (_label, init) => {
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(
        clickLink("https://tracetxn.test/login", init).softNavigationHandlerRan,
      ).toBe(true);
    });

    it("removes the listener once Clarity is no longer running", () => {
      const { rerender } = renderWithUser(
        <ClarityAnalytics projectId={PROJECT_ID} />,
      );
      pathname.mockReturnValue("/login");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(
        clickLink("https://tracetxn.test/app/dashboard")
          .softNavigationHandlerRan,
      ).toBe(true);
    });
  });

  describe("backstop for programmatic navigation", () => {
    // Not the boundary — the click listener is. This only limits the damage if
    // a tracked page ever calls router.push() into a denied route.
    it("reloads once when a live recording reaches a denied route", () => {
      const { rerender } = renderWithUser(
        <ClarityAnalytics projectId={PROJECT_ID} />,
      );
      expect(scripts()).toHaveLength(1);

      pathname.mockReturnValue("/login");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);

      expect(reload).toHaveBeenCalledTimes(1);
      expect(scripts()).toHaveLength(0);
    });

    it("does not reload when the visitor lands on a denied route directly", () => {
      pathname.mockReturnValue("/login");
      renderWithUser(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(reload).not.toHaveBeenCalled();
    });

    it("cannot cascade: the reloaded document reloads no further", () => {
      const { rerender } = renderWithUser(
        <ClarityAnalytics projectId={PROJECT_ID} />,
      );
      pathname.mockReturnValue("/login");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(reload).toHaveBeenCalledTimes(1);

      pathname.mockReturnValue("/app/dashboard");
      rerender(<ClarityAnalytics projectId={PROJECT_ID} />);
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
