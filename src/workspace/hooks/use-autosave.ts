"use client";

import * as React from "react";

import { ApiClientError } from "@/lib/api-client";

export type AutosaveStatus =
  | "idle"
  | "scheduled"
  | "saving"
  | "saved"
  | "error";

export interface AutosaveState {
  status: AutosaveStatus;
  /** ISO timestamp of the last successful save, or null. */
  lastSavedAt: string | null;
  /** Most recent error message, or null. */
  error: string | null;
  /** Force flush any pending save immediately. Resolves once written. */
  flush: () => Promise<void>;
}

interface UseAutosaveOptions<T> {
  /** The current value to save. Treated as "dirty" when it changes. */
  value: T;
  /**
   * Debounce interval in ms. Default 1000ms — balances "feels responsive"
   * with not hammering the server on every keystroke.
   */
  debounceMs?: number;
  /**
   * Cheap equality check — if the new value equals the last-saved one,
   * skip the save entirely. Pass JSON.stringify-equality for plain shapes.
   */
  isEqual?: (a: T, b: T) => boolean;
  /**
   * Whether autosave is enabled. Use this to delay saves until the form
   * is dirty / past initial hydration.
   */
  enabled?: boolean;
  /** The save function. Must reject on failure for status to flip. */
  save: (value: T) => Promise<void>;
}

const defaultEqual = <T,>(a: T, b: T): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
};

/**
 * Generic debounced autosave for arbitrary serializable form state.
 *
 * Why not just call `save` on every change?
 *  - Drafts API is a real network call. We want at most one in flight per
 *    debounce window.
 *  - Page navigation / tab close must flush whatever's pending, so the
 *    hook returns a `flush()` you can wire to a beforeunload listener.
 */
export function useAutosave<T>({
  value,
  debounceMs = 1000,
  isEqual = defaultEqual,
  enabled = true,
  save,
}: UseAutosaveOptions<T>): AutosaveState {
  const [status, setStatus] = React.useState<AutosaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const lastSavedValue = React.useRef<T>(value);
  const pendingValue = React.useRef<T>(value);
  const timer = React.useRef<number | null>(null);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const isEqualRef = React.useRef(isEqual);
  const saveRef = React.useRef(save);
  React.useEffect(() => {
    isEqualRef.current = isEqual;
    saveRef.current = save;
  });

  // Internal: actually run a save. Coalesces with any save already in
  // flight so we never have two concurrent writes for the same form. If
  // changes happened while a save was in-flight, we save the latest value
  // (not the snapshot we were called with) once the previous write finishes.
  const runSave = React.useCallback(async () => {
    // Wait out any in-flight save.
    while (inFlight.current) {
      try {
        await inFlight.current;
      } catch {
        // Previous write's error already surfaced via status; just continue.
      }
    }
    const target = pendingValue.current;
    if (isEqualRef.current(target, lastSavedValue.current)) return;
    setStatus("saving");
    setError(null);
    const promise = (async () => {
      try {
        await saveRef.current(target);
        lastSavedValue.current = target;
        setLastSavedAt(new Date().toISOString());
        setStatus("saved");
      } catch (err) {
        const message =
          err instanceof ApiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Autosave failed";
        setError(message);
        setStatus("error");
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = promise;
    await promise;
  }, []);

  // Schedule a debounced save whenever the value changes.
  React.useEffect(() => {
    pendingValue.current = value;
    if (!enabled) return;
    if (isEqualRef.current(value, lastSavedValue.current)) return;
    setStatus("scheduled");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void runSave();
    }, debounceMs);
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, debounceMs, enabled, runSave]);

  // Flush pending saves on tab close — best effort, browsers may abort.
  React.useEffect(() => {
    if (!enabled) return;
    function onBeforeUnload() {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        // Fire-and-forget; the browser may not wait for it.
        void runSave();
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [enabled, runSave]);

  const flush = React.useCallback(async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (isEqualRef.current(pendingValue.current, lastSavedValue.current)) {
      return;
    }
    await runSave();
  }, [runSave]);

  return { status, lastSavedAt, error, flush };
}
