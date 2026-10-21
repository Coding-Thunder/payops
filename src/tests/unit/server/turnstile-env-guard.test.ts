// @vitest-environment node
//
// `env.server` refuses to load when `window` exists, so this file opts out of
// the project's default jsdom.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/**
 * A Turnstile secret with no site key is a TOTAL AUTHENTICATION OUTAGE.
 *
 * The two variables are independently optional, and exactly one of the four
 * combinations is fatal: with no site key the widget never renders, so no
 * token is ever produced, so `verifyTurnstile` throws BOT_CHECK_FAILED on
 * every request to every protected endpoint — sign-in, signup, activation,
 * password reset. Nothing detected it. The deployment would simply stop
 * authenticating anyone, with a captcha error as the only clue.
 *
 * The guard is deliberately ONE-DIRECTIONAL, and these tests pin that
 * asymmetry so nobody "tidies" it into a symmetric rule:
 *   - secret, no site key  -> must FAIL at boot (the outage)
 *   - site key, no secret  -> must BOOT (degraded: a widget the server does
 *                            not check, which is not an outage; and a
 *                            NEXT_PUBLIC_ var is inlined at build time while
 *                            this schema runs at request time, so a symmetric
 *                            rule could fail a boot for a value that simply
 *                            was not in the build environment)
 *   - both set             -> must BOOT (production)
 *   - both unset           -> must BOOT (local dev and both test suites)
 */

const SECRET = "TURNSTILE_SECRET_KEY";
const SITE = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

let saved: { secret?: string; site?: string };

beforeEach(() => {
  saved = { secret: process.env[SECRET], site: process.env[SITE] };
  vi.resetModules();
});

afterEach(() => {
  if (saved.secret === undefined) delete process.env[SECRET];
  else process.env[SECRET] = saved.secret;
  if (saved.site === undefined) delete process.env[SITE];
  else process.env[SITE] = saved.site;
  vi.resetModules();
});

/** Load a fresh copy of the module and try to read the server env. */
async function boots(): Promise<{ ok: boolean; message: string }> {
  vi.resetModules();
  try {
    const { env } = await import("@/lib/env");
    void env.server;
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function set(secret: string | undefined, site: string | undefined): void {
  if (secret === undefined) delete process.env[SECRET];
  else process.env[SECRET] = secret;
  if (site === undefined) delete process.env[SITE];
  else process.env[SITE] = site;
}

describe("Turnstile configuration guard", () => {
  it("REFUSES to boot with a secret and no site key", async () => {
    set("a-secret-value", undefined);
    const r = await boots();
    expect(r.ok).toBe(false);
    // The message has to name both variables and say what to do, because the
    // symptom (every request rejected) points nowhere near the cause.
    expect(r.message).toContain("TURNSTILE_SECRET_KEY");
    expect(r.message).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
    expect(r.message).toMatch(/reject every request|no widget renders/i);
  });

  it("boots with both set — production", async () => {
    set("a-secret-value", "a-site-key");
    expect((await boots()).ok).toBe(true);
  });

  it("boots with neither set — local dev and the test suites", async () => {
    set(undefined, undefined);
    expect((await boots()).ok).toBe(true);
  });

  it("boots with a site key and no secret — degraded, not an outage", async () => {
    set(undefined, "a-site-key");
    const r = await boots();
    expect(
      r.ok,
      "a symmetric rule would fail here, and must not: NEXT_PUBLIC_ vars are " +
        "inlined at build time while this schema runs at request time",
    ).toBe(true);
  });

  it("treats a whitespace-only secret as unset", async () => {
    set("   ", undefined);
    // Otherwise a stray space in a dashboard field trips the guard for a
    // deployment that has no Turnstile at all.
    expect((await boots()).ok).toBe(true);
  });
});
