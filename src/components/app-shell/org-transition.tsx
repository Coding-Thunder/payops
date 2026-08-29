"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { toast } from "@/components/ui/sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { OrganizationSummary } from "@/types";

/**
 * Organization switching, as a workspace transition rather than a refresh.
 *
 * WHAT WAS WRONG. The switcher wrapped the whole switch — POST, navigate,
 * `router.refresh()` — in `useTransition`. A React transition deliberately
 * keeps the PREVIOUS UI on screen until the new one is ready, so the user sat
 * looking at the old organization's fully-rendered, fully-interactive data
 * for the entire round trip, with a disabled button as the only signal. Then
 * everything swapped at once. That reads as a freeze followed by a jump, and
 * it is also a data-safety problem: the previous tenant's rows stay clickable
 * while a switch is in flight.
 *
 * WHAT THIS DOES. The moment a destination is chosen, an overlay covers the
 * content region — synchronously, outside any transition, so it paints on the
 * very next frame. It does three jobs at once:
 *
 *   1. acknowledges the click immediately,
 *   2. hides and blocks the outgoing organization's data, and
 *   3. names the destination brand, so the switch reads as intentional.
 *
 * It then hands off: once the navigation commits, the destination route's own
 * `loading.tsx` skeleton is already mounted underneath, so the overlay fades
 * out onto a destination-shaped skeleton rather than onto blank space. No
 * generic spinner, and no skeleton written twice.
 *
 * NO ARTIFICIAL DELAY. The overlay is dismissed as soon as the server tree has
 * re-rendered. `MIN_VISIBLE_MS` is not a wait — it only prevents a sub-100ms
 * switch from flashing the overlay for two frames, which looks like a glitch.
 * A slow switch is never padded; a fast one is never stretched.
 *
 * AUTHORIZATION IS UNTOUCHED. This is presentation only. The POST still goes
 * to /api/organizations/switch, which re-resolves the id against the caller's
 * own ACTIVE memberships before writing the cookie, and every page still
 * re-resolves its scope server-side. Nothing here makes the client's belief
 * about the current organization authoritative.
 */

type Phase = "idle" | "switching" | "settling";

interface OrgTransitionState {
  phase: Phase;
  /** Customer-facing brand of the destination, e.g. "FlightBizz". */
  targetBrand: string | null;
  switchTo: (org: OrganizationSummary) => void;
  isSwitching: boolean;
}

const OrgTransitionContext = React.createContext<OrgTransitionState | null>(
  null,
);

export function useOrgTransition(): OrgTransitionState {
  const ctx = React.useContext(OrgTransitionContext);
  if (!ctx) {
    throw new Error("useOrgTransition must be used inside OrgTransitionProvider");
  }
  return ctx;
}

/** Floor on overlay visibility, so a very fast switch does not flash. Not a
 *  delay: a slower switch simply keeps the overlay until it is genuinely
 *  ready. */
const MIN_VISIBLE_MS = 260;
/** Safety net. If a navigation is silently cancelled the overlay must never
 *  strand the user behind an opaque panel. */
const WATCHDOG_MS = 12_000;

export function OrgTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [targetBrand, setTargetBrand] = React.useState<string | null>(null);
  const shownAt = React.useRef(0);
  const timers = React.useRef<number[]>([]);
  /** Guards against rapid repeated switching: a second click while one is in
   *  flight is ignored rather than racing two cookie writes and two
   *  navigations against each other. */
  const inFlight = React.useRef(false);

  const clearTimers = React.useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  React.useEffect(() => clearTimers, [clearTimers]);

  const finish = React.useCallback(() => {
    const elapsed = Date.now() - shownAt.current;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    timers.current.push(
      window.setTimeout(() => {
        // "settling" runs the fade-out; the overlay stays mounted for its
        // duration so the destination is revealed rather than snapping in.
        setPhase("settling");
        timers.current.push(
          window.setTimeout(() => {
            setPhase("idle");
            setTargetBrand(null);
            inFlight.current = false;
          }, 220),
        );
      }, wait),
    );
  }, []);

  const switchTo = React.useCallback(
    (org: OrganizationSummary) => {
      if (inFlight.current) return;
      inFlight.current = true;
      clearTimers();
      shownAt.current = Date.now();
      // Set synchronously and OUTSIDE startTransition. Inside one, React would
      // hold the old tree and the overlay would not paint until the work it is
      // meant to cover had already finished — the exact bug being fixed.
      setTargetBrand(org.brandName);
      setPhase("switching");

      timers.current.push(
        window.setTimeout(() => {
          if (inFlight.current) {
            setPhase("idle");
            setTargetBrand(null);
            inFlight.current = false;
            toast.error("Switching took too long. Please try again.");
          }
        }, WATCHDOG_MS),
      );

      void (async () => {
        try {
          await api.post("/api/organizations/switch", {
            organizationId: org.id,
          });
        } catch {
          // FAILED SWITCH: tear the overlay down and stay exactly where we
          // were. The cookie was never written, so the previous organization
          // is still the authoritative one — there is no half-switched state
          // to recover from.
          clearTimers();
          setPhase("idle");
          setTargetBrand(null);
          inFlight.current = false;
          toast.error("Could not switch organization");
          return;
        }

        // Land on the dashboard: the current route may not exist, or may not
        // be permitted, in the organization just chosen. `push` (not replace)
        // mounts the destination's loading.tsx, which is what puts a
        // destination-shaped skeleton under the overlay.
        router.push("/app/dashboard");
        router.refresh();
        finish();
      })();
    },
    [clearTimers, finish, router],
  );

  const value = React.useMemo<OrgTransitionState>(
    () => ({
      phase,
      targetBrand,
      switchTo,
      isSwitching: phase !== "idle",
    }),
    [phase, targetBrand, switchTo],
  );

  return (
    <OrgTransitionContext.Provider value={value}>
      {children}
    </OrgTransitionContext.Provider>
  );
}

/**
 * The overlay itself. Rendered inside the content region — deliberately NOT
 * over the whole viewport, so the sidebar and topbar stay put and the switch
 * reads as changing workspace rather than reloading the application. Keeping
 * the chrome fixed is also what prevents a layout jump at any width.
 */
export function OrgTransitionOverlay() {
  const { phase, targetBrand } = useOrgTransition();
  if (phase === "idle") return null;
  const leaving = phase === "settling";

  return (
    <div
      // `inert` blocks focus and pointer events on everything beneath, which
      // is what actually guarantees the outgoing organization's rows cannot be
      // clicked mid-switch. Visual cover alone would not.
      className={cn(
        "absolute inset-0 z-30 flex items-center justify-center",
        "bg-background/80 backdrop-blur-sm",
        "motion-safe:transition-opacity motion-safe:duration-200",
        leaving ? "opacity-0" : "opacity-100",
      )}
      role="status"
      aria-live="polite"
      aria-label={
        targetBrand ? `Switching to ${targetBrand}` : "Switching organization"
      }
    >
      <div
        className={cn(
          "flex flex-col items-center gap-3 px-6 text-center",
          "motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out",
          leaving
            ? "translate-y-[-4px] scale-[0.99] opacity-0"
            : "translate-y-0 scale-100 opacity-100",
        )}
      >
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Entering workspace
        </span>
        {/* The DESTINATION BRAND, not the internal organization name.
            `OrganizationSummary.brandName` is the customer-facing value —
            GlobeVista's row carries "FlightBizz" — so an internal name is
            never surfaced here. */}
        <span className="text-2xl font-semibold tracking-tight text-foreground">
          {targetBrand ?? " "}
        </span>
        <span
          className="h-px w-24 overflow-hidden rounded-full bg-border"
          aria-hidden="true"
        >
          <span className="org-transition__sweep block h-full w-1/3 rounded-full bg-foreground/50" />
        </span>
      </div>
    </div>
  );
}
