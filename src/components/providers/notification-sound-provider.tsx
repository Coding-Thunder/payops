"use client";

import * as React from "react";

import {
  isAudioReady,
  playTone,
  unlockAudio,
  type NotificationTone,
} from "@/lib/notification-sound";

/**
 * Global notification-sound preference and playback.
 *
 * GLOBAL TO THE CONSOLE, NOT TO AN ORGANIZATION. The preference is stored
 * under a single un-namespaced localStorage key, so it is one setting for the
 * whole browser: switching between RentalConfirmation, TripReservations and
 * FlightBizz never changes it, and it is deliberately NOT part of any
 * organization document or organization-scoped settings. It survives
 * navigation and reload for the same reason.
 *
 * The provider sits above the organization layer in the tree, so an
 * organization switch never unmounts it and the toggle keeps its position
 * and state throughout.
 *
 * AUTOPLAY. Browsers refuse audio until the user has interacted with the
 * document. Rather than trying to detect that policy we listen once for the
 * first genuine gesture — pointer, key or touch — and resume the AudioContext
 * there. Until that happens sound is simply silent; nothing errors, and no
 * event is lost, because the visual toast and the activity feed are driven
 * independently of this.
 */

const STORAGE_KEY = "payops.notification-sound";

interface NotificationSoundState {
  /** User preference. Independent of whether audio is unlocked yet. */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  /** True once the browser has actually allowed audio. */
  unlocked: boolean;
  /** Play a tone, honouring the preference and the unlock state. */
  play: (tone: NotificationTone) => void;
}

const Ctx = React.createContext<NotificationSoundState | null>(null);

export function useNotificationSound(): NotificationSoundState {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useNotificationSound must be used inside NotificationSoundProvider",
    );
  }
  return ctx;
}

/**
 * localStorage IS an external store, so it is read through
 * `useSyncExternalStore` rather than mirrored into state by a mount effect.
 * That avoids a hydration mismatch (the server snapshot is the default),
 * avoids the cascading-render an effect-then-setState would cause, and gives
 * cross-tab consistency for free: the `storage` event is part of the same
 * subscription, so flipping the toggle in one tab silences the others.
 */
const listeners = new Set<() => void>();

function emitPreferenceChange() {
  for (const l of listeners) l();
}

function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires in OTHER tabs; `listeners` covers this one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readStoredPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Default ON. An operations console exists to be noticed; an operator who
    // does not want it turns it off once and that choice persists.
    return raw === null ? true : raw === "on";
  } catch {
    // Private mode / blocked storage. Fall back to the default rather than
    // failing — the toggle still works for the session.
    return true;
  }
}

export function NotificationSoundProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const enabled = React.useSyncExternalStore(
    subscribePreference,
    readStoredPreference,
    // Server snapshot: the default. The markup therefore never depends on
    // localStorage and cannot hydrate-mismatch.
    () => true,
  );
  const [unlocked, setUnlocked] = React.useState(false);
  // Mirrored into a ref so `play` — called from a long-lived EventSource
  // handler — always reads the CURRENT preference rather than the value
  // captured when the callback was created. Turning sound off must silence
  // the very next event, not the one after it.
  //
  // Synced in an effect rather than assigned during render: writing a ref
  // mid-render is what the react-hooks rule forbids, and it is the same
  // pattern realtime-provider.tsx already uses for its refs.
  const enabledRef = React.useRef(enabled);
  React.useEffect(() => {
    enabledRef.current = enabled;
  });

  const setEnabled = React.useCallback((v: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
    } catch {
      // Storage unavailable (private mode). The write is lost, so the
      // preference is session-only, but the toggle still works.
    }
    emitPreferenceChange();
    // Turning it ON is itself a user gesture, so it is the right moment to
    // unlock audio — otherwise the first event after enabling would still be
    // silent and the toggle would look broken.
    if (v) void unlockAudio().then((ok) => setUnlocked(ok));
  }, []);

  const toggle = React.useCallback(() => {
    setEnabled(!enabledRef.current);
  }, [setEnabled]);

  // Unlock on the FIRST real interaction anywhere in the document.
  React.useEffect(() => {
    if (unlocked) return;
    let done = false;
    const onFirst = () => {
      if (done) return;
      done = true;
      void unlockAudio().then((ok) => setUnlocked(ok || isAudioReady()));
      detach();
    };
    function detach() {
      document.removeEventListener("pointerdown", onFirst);
      document.removeEventListener("keydown", onFirst);
      document.removeEventListener("touchstart", onFirst);
    }
    document.addEventListener("pointerdown", onFirst, { once: true });
    document.addEventListener("keydown", onFirst, { once: true });
    document.addEventListener("touchstart", onFirst, { once: true });
    return detach;
  }, [unlocked]);

  const play = React.useCallback((tone: NotificationTone) => {
    // Read from the ref so a tone fired from a long-lived event handler
    // always sees the CURRENT preference — turning sound off must silence
    // the very next event, not the one after.
    if (!enabledRef.current) return;
    playTone(tone);
  }, []);

  const value = React.useMemo<NotificationSoundState>(
    () => ({ enabled, setEnabled, toggle, unlocked, play }),
    [enabled, setEnabled, toggle, unlocked, play],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
