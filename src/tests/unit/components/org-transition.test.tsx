import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  OrgTransitionOverlay,
  OrgTransitionProvider,
  useOrgTransition,
} from "@/components/app-shell/org-transition";
import { renderWithUser, screen, waitFor } from "@/tests/utils/render";
import type { OrganizationSummary } from "@/types";

/**
 * Organization-switch transition state.
 *
 * The bug this guards: the switch used to run inside `useTransition`, which
 * by design keeps the PREVIOUS UI mounted until the new one is ready. The
 * outgoing organization's data therefore stayed on screen — and clickable —
 * for the whole round trip, then everything swapped at once. That is both
 * the "freeze then jump" feel and a genuine cross-tenant exposure while a
 * switch is in flight.
 *
 * So these tests assert the properties that were violated, not that an
 * element merely exists: the overlay must appear WITHOUT waiting on the
 * network, it must name the DESTINATION BRAND, a failure must return to a
 * clean previous state rather than a half-switched one, and a second click
 * mid-flight must not start a second switch.
 */

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: { error: (m: string) => toastError(m), success: vi.fn() },
}));

const GLOBEVISTA: OrganizationSummary = {
  id: "6a92a08d27239e5a6e0f0316",
  slug: "globevista",
  // Internal name vs customer-facing brand — the distinction under test.
  name: "GlobeVista",
  brandName: "FlightBizz",
};

/** Minimal harness exposing the context to the test. */
function Harness() {
  const { switchTo, isSwitching, targetBrand } = useOrgTransition();
  return (
    <div>
      <button onClick={() => switchTo(GLOBEVISTA)}>go</button>
      <span data-testid="flag">{String(isSwitching)}</span>
      <span data-testid="brand">{targetBrand ?? ""}</span>
      <OrgTransitionOverlay />
    </div>
  );
}

function renderHarness() {
  return renderWithUser(
    <OrgTransitionProvider>
      <Harness />
    </OrgTransitionProvider>,
  );
}

describe("organization switch transition", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    toastError.mockReset();
  });

  it("shows the overlay BEFORE the network call resolves", async () => {
    // A POST that never settles. If the overlay depended on the request
    // finishing — the old behaviour — nothing would render here at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { user } = renderHarness();

    await user.click(screen.getByText("go"));

    await waitFor(() => {
      expect(screen.getByTestId("flag").textContent).toBe("true");
    });
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Switching to FlightBizz",
    );
  });

  it("names the customer-facing BRAND, never the internal organization name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { user } = renderHarness();
    await user.click(screen.getByText("go"));

    await waitFor(() => {
      expect(screen.getByTestId("brand").textContent).toBe("FlightBizz");
    });
    const overlay = screen.getByRole("status");
    expect(overlay).toHaveTextContent("FlightBizz");
    // The internal name must not leak into the transition.
    expect(overlay).not.toHaveTextContent("GlobeVista");
  });

  it("navigates and refreshes only AFTER the switch is accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );
    const { user } = renderHarness();
    await user.click(screen.getByText("go"));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/app/dashboard");
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("a FAILED switch tears the overlay down and leaves no half-switched state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "no" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )),
    );
    const { user } = renderHarness();
    await user.click(screen.getByText("go"));

    await waitFor(() => {
      expect(screen.getByTestId("flag").textContent).toBe("false");
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("brand").textContent).toBe("");
    // Critically: it must NOT have navigated. Staying put is what keeps the
    // previous organization the valid one.
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("ignores a second switch while one is already in flight", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { user } = renderHarness();

    await user.click(screen.getByText("go"));
    await user.click(screen.getByText("go"));
    await user.click(screen.getByText("go"));

    // Rapid repeated switching must not race several cookie writes and
    // navigations against each other.
    await waitFor(() => {
      expect(screen.getByTestId("flag").textContent).toBe("true");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws if the hook is used outside the provider", () => {
    // Guards against the overlay being mounted somewhere that silently has
    // no context and therefore never covers anything.
    function Orphan() {
      useOrgTransition();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderWithUser(<Orphan />)).toThrow(
      /must be used inside OrgTransitionProvider/i,
    );
    spy.mockRestore();
  });
});
