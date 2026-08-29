/**
 * Notification tones for meaningful order and payment events.
 *
 * SYNTHESISED, not sampled. Every tone below is generated with a couple of
 * oscillators and a gain envelope, which buys three things that matter more
 * than fidelity here:
 *
 *   - no binary assets to license, host, cache-bust or ship (the app already
 *     had one asset-storage incident; this adds no new one),
 *   - nothing to download, so a sound never lags the toast it belongs to,
 *   - exact control over length and loudness, which is what keeps an alert
 *     that fires all day from becoming intolerable.
 *
 * DESIGN RULES, chosen because operators hear these for hours:
 *   - under ~320ms each, so two events in quick succession never overlap
 *     into mush;
 *   - sine and triangle waves only — no sawtooth or square, which read as
 *     "error buzzer" and fatigue quickly;
 *   - peak gain well under 1.0, with an exponential release so every tone
 *     ends softly rather than clicking;
 *   - pitch carries the meaning. Rising intervals for good outcomes, falling
 *     for bad, a single neutral tap for informational. An operator learns
 *     these without being taught them.
 */

export type NotificationTone =
  | "order"
  | "authorized"
  | "paid"
  | "captured"
  | "failed"
  | "refunded"
  | "dispute";

interface ToneStep {
  /** Hz. */
  freq: number;
  /** Seconds from the start of the tone. */
  at: number;
  /** Seconds. */
  dur: number;
  type?: OscillatorType;
  /** Peak gain for this step, before the master volume. */
  gain?: number;
}

/**
 * One recipe per business event.
 *
 * The vocabulary is deliberate and consistent:
 *   order      one soft neutral tap — something arrived, nothing is decided
 *   authorized two rising notes, gentle — money is HELD, not taken
 *   paid       two rising notes, brighter and a third higher — money moved
 *   captured   a confident rising third — the hold became a charge
 *   failed     two falling notes — unmistakably negative without alarming
 *   refunded   a downward step, softer than failure — money went back, which
 *              is orderly rather than wrong
 *   dispute    a low double pulse — the only tone that should make an
 *              operator look up immediately
 */
const RECIPES: Record<NotificationTone, ToneStep[]> = {
  order: [{ freq: 660, at: 0, dur: 0.12, gain: 0.16 }],
  authorized: [
    { freq: 587.33, at: 0, dur: 0.1, gain: 0.14 }, // D5
    { freq: 739.99, at: 0.08, dur: 0.14, gain: 0.13 }, // F#5
  ],
  paid: [
    { freq: 659.25, at: 0, dur: 0.1, gain: 0.16 }, // E5
    { freq: 830.61, at: 0.075, dur: 0.1, gain: 0.15 }, // G#5
    { freq: 987.77, at: 0.15, dur: 0.16, gain: 0.14 }, // B5
  ],
  captured: [
    { freq: 523.25, at: 0, dur: 0.1, gain: 0.16 }, // C5
    { freq: 783.99, at: 0.085, dur: 0.18, gain: 0.15 }, // G5
  ],
  failed: [
    { freq: 440, at: 0, dur: 0.11, gain: 0.15, type: "triangle" }, // A4
    { freq: 329.63, at: 0.09, dur: 0.19, gain: 0.14, type: "triangle" }, // E4
  ],
  refunded: [
    { freq: 587.33, at: 0, dur: 0.1, gain: 0.13 }, // D5
    { freq: 466.16, at: 0.085, dur: 0.15, gain: 0.12 }, // A#4
  ],
  dispute: [
    { freq: 311.13, at: 0, dur: 0.14, gain: 0.17, type: "triangle" }, // D#4
    { freq: 311.13, at: 0.17, dur: 0.16, gain: 0.17, type: "triangle" },
  ],
};

/** Master ceiling applied on top of each step's gain. Deliberately quiet:
 *  these fire unattended in a shared office. */
const MASTER_GAIN = 0.5;

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Lazily-created shared context.
 *
 * One per document, created on first use rather than at import: browsers cap
 * the number of contexts, and creating one before any user gesture just
 * yields a suspended context we would have to resume anyway.
 */
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** True once the context exists and is running — i.e. audio will be heard. */
export function isAudioReady(): boolean {
  return ctx !== null && ctx.state === "running";
}

/**
 * Resume the context. MUST be called from inside a real user-gesture handler.
 *
 * Browsers block audio until the user has interacted with the document, and a
 * context created beforehand starts "suspended". Rather than trying to detect
 * that policy, we simply attempt a resume on the first genuine interaction and
 * report whether it took.
 */
export async function unlockAudio(): Promise<boolean> {
  const c = getContext();
  if (!c) return false;
  if (c.state === "running") return true;
  try {
    await c.resume();
    // Re-read through a widened type: TypeScript narrowed `state` on the
    // early return above and cannot know that `resume()` mutates it.
    return (c.state as AudioContextState | string) === "running";
  } catch {
    return false;
  }
}

/**
 * Play one tone. Silent no-op when audio is unavailable or still locked —
 * never throws, because a notification sound failing must never take a toast
 * or a cache invalidation down with it.
 */
export function playTone(tone: NotificationTone, volume = 1): void {
  const c = getContext();
  if (!c || c.state !== "running") return;

  const recipe = RECIPES[tone];
  if (!recipe) return;

  const now = c.currentTime;
  for (const step of recipe) {
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = step.type ?? "sine";
      osc.frequency.setValueAtTime(step.freq, now + step.at);

      const peak = (step.gain ?? 0.15) * MASTER_GAIN * volume;
      // Short attack then exponential decay. `linearRamp` in and
      // `exponentialRamp` out is what stops the click you get from a hard
      // start/stop on a raw oscillator.
      gain.gain.setValueAtTime(0.0001, now + step.at);
      gain.gain.linearRampToValueAtTime(peak, now + step.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + step.at + step.dur,
      );

      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(now + step.at);
      osc.stop(now + step.at + step.dur + 0.02);
    } catch {
      // A single failed step must not abort the rest of the tone.
    }
  }
}

/** Test seam: drop the shared context so a suite can start clean. */
export function _resetAudioForTests(): void {
  try {
    void ctx?.close();
  } catch {
    /* already closed */
  }
  ctx = null;
}

/** Every tone name, for the settings preview. */
export const NOTIFICATION_TONES = Object.keys(RECIPES) as NotificationTone[];
