import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  _resetNotificationDedupe,
  resolveEventTone,
} from "@/components/providers/realtime-provider";
import {
  NotificationSoundProvider,
  useNotificationSound,
} from "@/components/providers/notification-sound-provider";
import { DomainEventType, type DomainEvent } from "@/lib/constants/events";
import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * Notification sounds: deduplication and the global preference.
 *
 * The sound layer rides the EXISTING realtime pipeline — the same
 * EventSource pass that already raises the toast and invalidates the query
 * cache — so there is no second subscription to test. What IS worth pinning
 * is the part that goes wrong in production: one business event must produce
 * exactly one sound, no matter how many raw gateway deliveries, reconcile
 * races, socket reconnects or open tabs stand behind it.
 *
 * `playTone` itself is a no-op without a running AudioContext, so these
 * assert the DECISION (`resolveEventTone`) rather than audio output — jsdom
 * has no Web Audio implementation and asserting on it would test the mock.
 */

/**
 * jsdom in this project does not expose a working localStorage, so the
 * preference tests supply one. Deliberately a real in-memory implementation
 * rather than a vi.fn() pair: these assert that a value round-trips, and a
 * mock that records calls without storing anything would pass while the
 * preference silently failed to persist.
 */
function installMemoryStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

let seq = 0;
function evt(
  type: DomainEventType,
  payload: Record<string, unknown> = {},
  id?: string,
): DomainEvent {
  seq += 1;
  return {
    type,
    id: id ?? `evt_${seq}`,
    at: new Date().toISOString(),
    actor: { id: null, name: null, role: null },
    audience: { kind: "admins" },
    payload,
  } as DomainEvent;
}

beforeEach(() => {
  _resetNotificationDedupe();
  vi.useRealTimers();
  installMemoryStorage();
});

describe("event → tone mapping", () => {
  it("maps each meaningful business event to a distinct tone", () => {
    const got = {
      created: resolveEventTone(evt(DomainEventType.ORDER_CREATED, { orderId: "a" })),
      authorized: resolveEventTone(evt(DomainEventType.ORDER_AUTHORIZED, { orderId: "b" })),
      paid: resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "c" })),
      failed: resolveEventTone(evt(DomainEventType.ORDER_FAILED, { orderId: "d" })),
      refunded: resolveEventTone(evt(DomainEventType.ORDER_REFUNDED, { orderId: "e" })),
      dispute: resolveEventTone(evt(DomainEventType.ORDER_DISPUTE_CREATED, { orderId: "f" })),
    };
    expect(got).toEqual({
      created: "order",
      authorized: "authorized",
      paid: "paid",
      failed: "failed",
      refunded: "refunded",
      dispute: "dispute",
    });
    // Distinctness is the point — six events, six different sounds.
    expect(new Set(Object.values(got)).size).toBe(6);
  });

  it("stays silent for operator-initiated and informational events", () => {
    // The operator is looking at the screen for these; a sound would be
    // noise. They still toast and still update the feed.
    for (const t of [
      DomainEventType.ORDER_EMAIL_SENT,
      DomainEventType.ORDER_LINK_REGENERATED,
      DomainEventType.ORDER_CONSENT_RECEIVED,
      DomainEventType.ORDER_CONFIRMATION_SENT,
      DomainEventType.ORDER_DISPUTE_UPDATED,
      DomainEventType.ORDER_EXPIRED,
    ]) {
      expect(resolveEventTone(evt(t, { orderId: `q-${t}` }))).toBeNull();
    }
  });

  it("gives a captured payment its own tone, distinct from a straight payment", () => {
    // A manual-capture order reaches PAID through the same shared transition
    // as any other, so the tone is chosen by whether it was authorized first.
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_AUTHORIZED, { orderId: "cap-1" })),
    ).toBe("authorized");
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "cap-1" })),
    ).toBe("captured");

    // An order never authorized gets the ordinary paid tone.
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "auto-1" })),
    ).toBe("paid");
  });
});

describe("deduplication", () => {
  it("plays once for a literally redelivered event id", () => {
    // What an EventSource reconnect does: the same emission arrives twice.
    const e = evt(DomainEventType.ORDER_PAID, { orderId: "o1" }, "evt_dupe");
    expect(resolveEventTone(e)).toBe("paid");
    expect(resolveEventTone(e)).toBeNull();
    expect(resolveEventTone({ ...e })).toBeNull();
  });

  it("plays once when the SAME business event arrives under different ids", () => {
    // The real production case: the webhook and the reconcile endpoint use
    // deliberately disjoint dedupe keys (`evt_…` vs `reconcile:…`), so both
    // can legitimately reach the client for one payment.
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "o2" }, "evt_stripe")),
    ).toBe("paid");
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "o2" }, "reconcile_o2")),
    ).toBeNull();
  });

  it("does NOT suppress the same event type on a DIFFERENT order", () => {
    // Rapid unrelated events must each be heard — suppressing them would
    // hide real activity during a busy period.
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "x1" })),
    ).toBe("paid");
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "x2" })),
    ).toBe("paid");
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_PAID, { orderId: "x3" })),
    ).toBe("paid");
  });

  it("does not suppress DIFFERENT event types on the same order", () => {
    // A genuine lifecycle: authorized then failed capture. Both matter.
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_AUTHORIZED, { orderId: "y1" })),
    ).toBe("authorized");
    expect(
      resolveEventTone(evt(DomainEventType.ORDER_FAILED, { orderId: "y1" })),
    ).toBe("failed");
  });

  it("survives a burst of duplicates without leaking sounds", () => {
    // 25 redeliveries of one business event — exactly one sound.
    let played = 0;
    for (let i = 0; i < 25; i++) {
      if (resolveEventTone(evt(DomainEventType.ORDER_DISPUTE_CREATED, { orderId: "burst" }, `id_${i}`))) {
        played += 1;
      }
    }
    expect(played).toBe(1);
  });

  it("handles an event with no orderId without collapsing unrelated events", () => {
    // Defensive: a malformed payload must not make every event share one
    // dedupe key and silence the rest.
    expect(resolveEventTone(evt(DomainEventType.ORDER_CREATED, {}))).toBe("order");
    expect(resolveEventTone(evt(DomainEventType.ORDER_FAILED, {}))).toBe("failed");
  });
});

function Harness() {
  const { enabled, toggle, play } = useNotificationSound();
  return (
    <div>
      <button onClick={toggle}>toggle</button>
      <button onClick={() => play("paid")}>play</button>
      <span data-testid="state">{enabled ? "on" : "off"}</span>
    </div>
  );
}

describe("global sound preference", () => {
  it("defaults to on and persists a change to localStorage", async () => {
    const { user } = renderWithUser(
      <NotificationSoundProvider>
        <Harness />
      </NotificationSoundProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("on"),
    );

    await user.click(screen.getByText("toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("off"),
    );
    // Global key — deliberately NOT namespaced per organization, so the
    // preference is one setting for the whole console.
    expect(window.localStorage.getItem("payops.notification-sound")).toBe("off");
  });

  it("restores a stored OFF preference on mount", async () => {
    window.localStorage.setItem("payops.notification-sound", "off");
    renderWithUser(
      <NotificationSoundProvider>
        <Harness />
      </NotificationSoundProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("off"),
    );
  });

  it("playing while disabled is a no-op and never throws", async () => {
    window.localStorage.setItem("payops.notification-sound", "off");
    const { user } = renderWithUser(
      <NotificationSoundProvider>
        <Harness />
      </NotificationSoundProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("off"),
    );
    // jsdom has no Web Audio; the guard must short-circuit before touching it.
    await expect(user.click(screen.getByText("play"))).resolves.toBeUndefined();
  });

  it("throws if the hook is used outside its provider", () => {
    function Orphan() {
      useNotificationSound();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderWithUser(<Orphan />)).toThrow(
      /must be used inside NotificationSoundProvider/i,
    );
    spy.mockRestore();
  });
});
