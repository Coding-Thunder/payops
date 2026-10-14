import fs from "node:fs";
import path from "node:path";

import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPTURE_MODES,
  CaptureMode,
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import {
  captureModeOrDefault,
  enabledGateways,
  MANUAL_CAPTURE_STRIPE_EVENTS,
  parseCaptureMode,
  planCaptureMode,
  stripeWebhookPath,
  UnknownCaptureModeError,
  type CaptureModePlan,
  type PaymentsConfig,
} from "@/lib/organization-capture-mode";
import { Organization } from "@/server/db/models";
import type { PaymentEventType } from "@/server/payments/gateway";
import { getDefaultGateway } from "@/server/payments/gateways";
import { createStripeGateway } from "@/server/payments/gateways/stripe";
import {
  getGatewayForOrganization,
  PaymentProviderNotConfiguredError,
} from "@/server/payments/resolve-gateway";
import { getStripeFor } from "@/server/payments/stripe";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildCheckoutExpired,
  buildPaymentIntentCanceled,
  buildPaymentIntentFailed,
  buildPaymentIntentSucceeded,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";

/**
 * Whether an organization's Stripe payments are charged at checkout
 * (AUTOMATIC) or authorized now and captured by an operator later (MANUAL)
 * — the pure rules behind `scripts/set-organization-capture-mode.ts`, the
 * script that opts an existing organization (Rental Confirmation, the
 * DEFAULT organization, included) into "Capture payment" / "Release hold".
 *
 * What this file proves:
 *   - parseCaptureMode / captureModeOrDefault: a blank or mistyped knob is
 *     refused, never guessed; nothing stored reads as AUTOMATIC; a stored
 *     value that is not a mode is refused rather than overwritten.
 *   - enabledGateways: checked against the REAL getGatewayForOrganization.
 *     For every stored shape this deployment writes (the provider inside its
 *     enabled list, or no list at all) and every gateway an operator could
 *     pick, the resolver honours exactly the ones this returns. So
 *     planCaptureMode refuses MANUAL exactly when no new link of that
 *     organization can be a Stripe link, and the gateways it reports as left
 *     charging at checkout are exactly the other ones a link can reach. Only
 *     the resolver's I/O is stubbed (the organization read, the credential
 *     vault and the connection); its own code runs.
 *   - Rental Confirmation, the DEFAULT organization, in each of the three
 *     shapes it can be stored in: whatever gateway is asked for, the real
 *     resolver hands back the DEPLOYMENT Stripe gateway (env credentials,
 *     through the default-organization fallback), and so does an order
 *     stored with no organization. MANUAL therefore reaches every new Rental
 *     link, and nothing is reported as left charging at checkout.
 *   - planCaptureMode: MANUAL is refused for an organization that takes no
 *     Stripe payments; going back to AUTOMATIC needs ALLOW_AUTOMATIC; asking
 *     for the mode already in force writes nothing, so an absent mode is
 *     never rewritten as an explicit AUTOMATIC.
 *   - stripeWebhookPath: the default organization keeps the deployment
 *     endpoint and every other organization gets its own. Both are real POST
 *     routes, and the per-organization one is what seed-globevista prints.
 *   - MANUAL_CAPTURE_STRIPE_EVENTS: exactly the events
 *     scripts/seed-globevista.ts tells an operator to subscribe to, read from
 *     that file's own console.log lines. The real Stripe webhook adapter
 *     (real SDK signature check included) handles each one as the lifecycle
 *     event it stands for, so none is "unhandled". Of its PaymentIntent
 *     events, only payment_intent.payment_failed also acts on a
 *     charge-at-checkout payment, which is the one the script warns about
 *     before the default organization's existing endpoint is subscribed.
 */

// The resolver's I/O, and nothing else. Its own selection code runs.
vi.mock("@/server/db/mongoose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/mongoose")>()),
  connectMongo: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/organization-credential.service", () => ({
  getSecret: vi.fn(async () => null),
}));

const { AUTOMATIC, MANUAL } = CaptureMode;
const { STRIPE, PAYPAL, RAZORPAY } = PaymentGatewayKey;

/** Frozen all the way down, so a rule that mutated its input would throw. */
function frozen(payments: PaymentsConfig): PaymentsConfig {
  return Object.freeze({
    ...payments,
    ...(payments.enabledProviders
      ? { enabledProviders: Object.freeze([...payments.enabledProviders]) }
      : {}),
  });
}

/** The error `fn` throws. Fails the test if it throws nothing. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, but nothing was thrown");
}

function readRepoFile(relative: string): string {
  // The unit setup already resolves `.env.payops.test` against the cwd.
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

/*
 * Production-shaped organizations. Rental Confirmation, the DEFAULT
 * organization, sells car rentals through Stripe only. A Stripe-only
 * document can be stored with no enabled list (written before the field
 * existed), an empty list (the schema default) or [STRIPE], and the rules
 * must read all three the same way.
 */
const RENTAL = { slug: "rentalconfirmation", isDefault: true } as const;
const RENTAL_NO_LIST = frozen({ provider: STRIPE });
const RENTAL_EMPTY_LIST = frozen({ provider: STRIPE, enabledProviders: [] });
const RENTAL_LISTED = frozen({ provider: STRIPE, enabledProviders: [STRIPE] });
/** TripReservations: PayPal is the default, its own Stripe account enabled alongside. */
const TRIP_RESERVATIONS = frozen({ provider: PAYPAL, enabledProviders: [PAYPAL, STRIPE] });
/** GlobeVista ("FlightBizz"): seeded Stripe-only, with MANUAL capture. */
const GLOBEVISTA = frozen({ provider: STRIPE, enabledProviders: [STRIPE] });
/** A PayPal-only brand. */
const PAYPAL_ONLY = frozen({ provider: PAYPAL, enabledProviders: [PAYPAL] });

const NOT_STRIPE_MESSAGE = (enabled: string) =>
  `This organization does not take Stripe payments (enabled: ${enabled}). Manual capture applies to Stripe only, so MANUAL would change nothing.`;
const ALLOW_AUTOMATIC_MESSAGE =
  "Switching from MANUAL back to AUTOMATIC: orders already authorized keep the manual lifecycle (each still needs Capture or Release). Set ALLOW_AUTOMATIC=1 as well to confirm.";
const OVERWRITE_MESSAGE = (shown: string) =>
  `The stored capture mode ${shown} is not AUTOMATIC or MANUAL — refusing to overwrite it.`;

describe("the two capture modes", () => {
  it("are AUTOMATIC and MANUAL, in that order — every refusal below names them so", () => {
    expect(CAPTURE_MODES).toEqual(["AUTOMATIC", "MANUAL"]);
    expect(AUTOMATIC).toBe("AUTOMATIC");
    expect(MANUAL).toBe("MANUAL");
  });
});

describe("parseCaptureMode — the script's CAPTURE_MODE knob", () => {
  it.each([
    { raw: "MANUAL", mode: MANUAL },
    { raw: "manual", mode: MANUAL },
    { raw: "mAnUaL", mode: MANUAL },
    { raw: "\tmanual\n", mode: MANUAL },
    { raw: "AUTOMATIC", mode: AUTOMATIC },
    { raw: "  Automatic  ", mode: AUTOMATIC },
  ])("reads $raw as $mode — trimmed, any case", ({ raw, mode }) => {
    expect(parseCaptureMode(raw)).toBe(mode);
  });

  it.each([
    { raw: undefined },
    { raw: null },
    { raw: "" },
    { raw: "   " },
    { raw: "\t\n" },
  ])("refuses $raw as an unset knob (not an unknown mode), naming both modes", ({ raw }) => {
    const err = caught(() => parseCaptureMode(raw));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnknownCaptureModeError);
    expect((err as Error).message).toBe("Set CAPTURE_MODE to AUTOMATIC or MANUAL.");
  });

  it.each([
    { raw: "MANUL", value: "MANUL" },
    { raw: "AUTO", value: "AUTO" },
    { raw: " auto ", value: "AUTO" },
    { raw: "manual capture", value: "MANUAL CAPTURE" },
    { raw: "MANUAL,AUTOMATIC", value: "MANUAL,AUTOMATIC" },
    { raw: "STRIPE", value: "STRIPE" },
  ])("refuses $raw as UnknownCaptureModeError carrying the value it read, $value", ({ raw, value }) => {
    const err = caught(() => parseCaptureMode(raw));
    expect(err).toBeInstanceOf(UnknownCaptureModeError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: "UnknownCaptureModeError",
      value,
      message: `Unknown capture mode: ${value}. Use AUTOMATIC or MANUAL.`,
    });
  });
});

describe("captureModeOrDefault — what an organization runs on today", () => {
  const READS: { what: string; stored: unknown; mode: CaptureMode }[] = [
    { what: "absent (a document stored before the field existed)", stored: undefined, mode: AUTOMATIC },
    { what: "null", stored: null, mode: AUTOMATIC },
    { what: "AUTOMATIC", stored: "AUTOMATIC", mode: AUTOMATIC },
    { what: "MANUAL", stored: "MANUAL", mode: MANUAL },
  ];
  for (const { what, stored, mode } of READS) {
    it(`reads a stored value that is ${what} as ${mode}`, () => {
      expect(captureModeOrDefault(stored)).toBe(mode);
    });
  }

  const REFUSED: { stored: unknown; shown: string }[] = [
    { stored: "manual", shown: '"manual"' },
    { stored: " MANUAL ", shown: '" MANUAL "' },
    { stored: "AUTO", shown: '"AUTO"' },
    { stored: "", shown: '""' },
    { stored: 1, shown: "1" },
    { stored: 0, shown: "0" },
    { stored: false, shown: "false" },
    { stored: {}, shown: "{}" },
    { stored: [], shown: "[]" },
    { stored: ["MANUAL"], shown: '["MANUAL"]' },
    { stored: { mode: "MANUAL" }, shown: '{"mode":"MANUAL"}' },
  ];
  for (const { stored, shown } of REFUSED) {
    it(`refuses the stored ${shown} rather than overwrite it — stored values are never normalized`, () => {
      const err = caught(() => captureModeOrDefault(stored));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(OVERWRITE_MESSAGE(shown));
    });
  }
});

describe("enabledGateways — the gateways an organization takes payments through", () => {
  const ROWS: { what: string; payments: PaymentsConfig | null | undefined; gateways: string[] }[] = [
    { what: "the enabled list when one is stored, in stored order", payments: TRIP_RESERVATIONS, gateways: [PAYPAL, STRIPE] },
    { what: "the enabled list even with no provider stored", payments: { enabledProviders: [STRIPE, PAYPAL] }, gateways: [STRIPE, PAYPAL] },
    { what: "the enabled list plus the provider when the provider sits outside it (a link with no pick falls back to it)", payments: { provider: STRIPE, enabledProviders: [RAZORPAY, PAYPAL] }, gateways: [RAZORPAY, PAYPAL, STRIPE] },
    { what: "[provider] for an empty list", payments: { provider: PAYPAL, enabledProviders: [] }, gateways: [PAYPAL] },
    { what: "[provider] for a null list", payments: { provider: PAYPAL, enabledProviders: null }, gateways: [PAYPAL] },
    { what: "[provider] with no list stored", payments: { provider: PAYPAL }, gateways: [PAYPAL] },
    { what: "[STRIPE] for Rental Confirmation stored with no list", payments: RENTAL_NO_LIST, gateways: [STRIPE] },
    { what: "[STRIPE] for Rental Confirmation stored with the empty default list", payments: RENTAL_EMPTY_LIST, gateways: [STRIPE] },
    { what: "[STRIPE] for Rental Confirmation stored listing [STRIPE]", payments: RENTAL_LISTED, gateways: [STRIPE] },
    { what: "[STRIPE] when nothing is stored", payments: {}, gateways: [STRIPE] },
    { what: "[STRIPE] for a null provider and an empty list", payments: { provider: null, enabledProviders: [] }, gateways: [STRIPE] },
    { what: "[STRIPE] for a null payments object", payments: null, gateways: [STRIPE] },
    { what: "[STRIPE] for no payments object at all", payments: undefined, gateways: [STRIPE] },
  ];
  for (const { what, payments, gateways } of ROWS) {
    it(`is ${what}`, () => {
      expect(enabledGateways(payments)).toEqual(gateways);
    });
  }

  it("hands back a copy: changing the result never changes the stored list", () => {
    const stored = [PAYPAL, STRIPE];
    const result = enabledGateways({ provider: PAYPAL, enabledProviders: stored });
    expect(result).not.toBe(stored);
    result.push(RAZORPAY);
    expect(stored).toEqual([PAYPAL, STRIPE]);
  });
});

describe("enabledGateways matches what the real getGatewayForOrganization honours", () => {
  // A non-default organization with no credentials anywhere: whichever
  // gateway the resolver settles on, it refuses it BY NAME — and that name
  // says which gateway it picked.
  const PROBE_ORG_ID = "64b7f0c2a1b2c3d4e5f60718";
  const PROBE = { slug: "captureparity", brandName: "Capture Parity Probe", isDefault: false };
  const GATEWAY_NAMED: Record<string, PaymentGatewayKey> = {
    Stripe: STRIPE,
    PayPal: PAYPAL,
    Razorpay: RAZORPAY,
    "Authorize.net": PaymentGatewayKey.AUTHORIZE_NET,
    "Manual invoice": PaymentGatewayKey.MANUAL,
  };

  beforeEach(() => {
    // No ORG_CAPTUREPARITY_* credential can leak in from the environment.
    for (const suffix of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_SANDBOX",
    ]) {
      vi.stubEnv(`ORG_CAPTUREPARITY_${suffix}`, "");
    }
    // Each refusal is logged as payments.gateway.not_configured.
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The gateway getGatewayForOrganization settles on for `pick` (null = no pick). */
  async function gatewayTheResolverPicks(
    payments: PaymentsConfig | null,
    pick: PaymentGatewayKey | null,
  ): Promise<PaymentGatewayKey> {
    vi.spyOn(Organization, "findById").mockReturnValue({
      select: () => ({ lean: async () => ({ ...PROBE, payments }) }),
    } as never);
    const outcome = await getGatewayForOrganization(PROBE_ORG_ID, pick).then(
      (gateway) => gateway,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(PaymentProviderNotConfiguredError);
    const message = (outcome as Error).message;
    const named = /^Capture Parity Probe has no (.+) credentials configured\./.exec(message)?.[1];
    const gateway = named === undefined ? undefined : GATEWAY_NAMED[named];
    expect(gateway, message).toBeDefined();
    return gateway as PaymentGatewayKey;
  }

  /*
   * Consistent documents (the provider inside its non-empty enabled list, or
   * no list at all — the shapes the seeds write) AND hand-edited ones whose
   * provider sits OUTSIDE a non-empty list. For the latter the resolver
   * falls back to that provider when there is no pick or an unlisted one
   * (`providerOverride && enabled.includes(providerOverride) ?
   * providerOverride : configured` in resolve-gateway.ts), so
   * enabledGateways must list it too — otherwise the script would refuse
   * MANUAL for an organization whose links ARE Stripe links, or leave a
   * gateway its links can reach out of "left charging at checkout".
   *
   * `manual` is the absolute outcome of asking for MANUAL: "refused", or
   * the gateways reported as left charging at checkout, in stored order.
   */
  const ROWS: {
    what: string;
    payments: PaymentsConfig | null;
    gateways: PaymentGatewayKey[];
    noPick: PaymentGatewayKey;
    manual: "refused" | PaymentGatewayKey[];
  }[] = [
    { what: "Rental Confirmation stored with no list", payments: RENTAL_NO_LIST, gateways: [STRIPE], noPick: STRIPE, manual: [] },
    { what: "Rental Confirmation stored with the empty default list", payments: RENTAL_EMPTY_LIST, gateways: [STRIPE], noPick: STRIPE, manual: [] },
    { what: "Rental Confirmation stored listing [STRIPE]", payments: RENTAL_LISTED, gateways: [STRIPE], noPick: STRIPE, manual: [] },
    { what: "TripReservations (PayPal default, Stripe enabled)", payments: TRIP_RESERVATIONS, gateways: [PAYPAL, STRIPE], noPick: PAYPAL, manual: [PAYPAL] },
    { what: "a PayPal-only brand", payments: PAYPAL_ONLY, gateways: [PAYPAL], noPick: PAYPAL, manual: "refused" },
    { what: "a PayPal provider with no list", payments: frozen({ provider: PAYPAL }), gateways: [PAYPAL], noPick: PAYPAL, manual: "refused" },
    { what: "three gateways", payments: frozen({ provider: STRIPE, enabledProviders: [STRIPE, PAYPAL, RAZORPAY] }), gateways: [STRIPE, PAYPAL, RAZORPAY], noPick: STRIPE, manual: [PAYPAL, RAZORPAY] },
    { what: "nothing stored", payments: frozen({}), gateways: [STRIPE], noPick: STRIPE, manual: [] },
    { what: "a null payments object", payments: null, gateways: [STRIPE], noPick: STRIPE, manual: [] },
    { what: "a hand-edited Stripe provider outside a PayPal-only list", payments: frozen({ provider: STRIPE, enabledProviders: [PAYPAL] }), gateways: [PAYPAL, STRIPE], noPick: STRIPE, manual: [PAYPAL] },
    { what: "a hand-edited PayPal provider outside a Stripe-only list", payments: frozen({ provider: PAYPAL, enabledProviders: [STRIPE] }), gateways: [STRIPE, PAYPAL], noPick: PAYPAL, manual: [PAYPAL] },
    { what: "a hand-edited PayPal provider outside a Razorpay-only list", payments: frozen({ provider: PAYPAL, enabledProviders: [RAZORPAY] }), gateways: [RAZORPAY, PAYPAL], noPick: PAYPAL, manual: "refused" },
  ];

  for (const { what, payments, gateways, noPick, manual } of ROWS) {
    const outcome = manual === "refused" ? "MANUAL is refused" : `MANUAL leaves [${manual.join(", ")}] charging at checkout`;
    it(`${what}: the resolver honours exactly [${gateways.join(", ")}], and ${outcome}`, async () => {
      // The pure rule, absolutely.
      expect(enabledGateways(payments)).toEqual(gateways);

      // The resolver, absolutely: with no pick it uses the provider…
      expect(await gatewayTheResolverPicks(payments, null)).toBe(noPick);
      // …and for every gateway an operator could pick, it honours the pick
      // exactly when that gateway is one of `gateways`.
      const reachable = new Set<PaymentGatewayKey>([noPick]);
      for (const pick of PAYMENT_GATEWAY_KEYS) {
        const picked = await gatewayTheResolverPicks(payments, pick);
        expect(picked, `pick ${pick}`).toBe(gateways.includes(pick) ? pick : noPick);
        reachable.add(picked);
      }
      expect([...reachable].sort()).toEqual([...gateways].sort());

      // So the script's guard agrees with link generation: MANUAL is refused,
      // for lacking Stripe and for nothing else, exactly when no new link of
      // this organization can be a Stripe link…
      const askForManual = () =>
        planCaptureMode({ stored: undefined, requested: MANUAL, payments, allowAutomatic: false });
      if (manual === "refused") {
        expect(reachable.has(STRIPE)).toBe(false);
        const err = caught(askForManual);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe(NOT_STRIPE_MESSAGE(gateways.join(", ")));
        return;
      }
      expect(reachable.has(STRIPE)).toBe(true);
      // …and what the script reports as left charging at checkout is every
      // other gateway a link of it can reach, no more and no fewer.
      expect(askForManual()).toStrictEqual({ before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: manual });
      expect([...manual].sort()).toEqual([...reachable].filter((g) => g !== STRIPE).sort());
    });
  }
});

describe("Rental Confirmation, the DEFAULT organization: every new link is a deployment Stripe link", () => {
  // Rental has no ORG_RENTALCONFIRMATION_* credentials and nothing in the
  // vault. For it the resolver must fall back to the DEPLOYMENT gateway (the
  // one reading STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET), never refuse and
  // never land on another gateway, whatever the composer sends.
  const RENTAL_ORG_ID = "64b7f0c2a1b2c3d4e5f6071a";
  const ENV_FALLBACK = "payments.gateway.env_fallback";

  beforeEach(() => {
    for (const suffix of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_SANDBOX",
    ]) {
      vi.stubEnv(`ORG_RENTALCONFIRMATION_${suffix}`, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const SHAPES: { what: string; payments: PaymentsConfig }[] = [
    { what: "stored with no list", payments: RENTAL_NO_LIST },
    { what: "stored with the empty default list", payments: RENTAL_EMPTY_LIST },
    { what: "stored listing [STRIPE]", payments: RENTAL_LISTED },
  ];

  for (const { what, payments } of SHAPES) {
    it(`${what}: no pick and every pick resolve to the deployment Stripe gateway, so MANUAL reaches every new link and leaves nothing charging at checkout`, async () => {
      const findById = vi.spyOn(Organization, "findById").mockReturnValue({
        select: () => ({
          lean: async () => ({ ...RENTAL, brandName: "Rental Confirmation", payments }),
        }),
      } as never);
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
      const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const deployment = getDefaultGateway();
      expect(deployment.key).toBe(STRIPE);
      const picks: (PaymentGatewayKey | null)[] = [null, ...PAYMENT_GATEWAY_KEYS];
      for (const pick of picks) {
        expect(await getGatewayForOrganization(RENTAL_ORG_ID, pick), `pick ${pick}`).toBe(deployment);
      }

      // Each call read Rental's own document and took the default
      // organization's env fallback for STRIPE, with no credential of its own.
      // It was not a short-circuit that skips the organization.
      expect(findById).toHaveBeenCalledTimes(picks.length);
      for (const [id] of findById.mock.calls) expect(id).toBe(RENTAL_ORG_ID);
      const fallbacks = info.mock.calls.filter(([message]) => message === ENV_FALLBACK);
      expect(fallbacks).toHaveLength(picks.length);
      for (const [, context] of fallbacks) {
        expect(context).toMatchObject({
          organizationId: RENTAL_ORG_ID,
          provider: STRIPE,
          hasSecretKey: false,
          hasWebhookSecret: false,
        });
      }
      expect(error).not.toHaveBeenCalled();

      // The pure rules say the same of this shape.
      expect(enabledGateways(payments)).toEqual([STRIPE]);
      expect(
        planCaptureMode({ stored: undefined, requested: MANUAL, payments, allowAutomatic: false }),
      ).toStrictEqual({ before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] });
      expect(stripeWebhookPath(RENTAL)).toBe("/api/webhooks/stripe");
    });
  }

  it("an order stored with no organization, which Rental also owns, resolves to the same deployment gateway without reading any organization", async () => {
    const findById = vi.spyOn(Organization, "findById");
    const deployment = getDefaultGateway();
    expect(await getGatewayForOrganization(null, null)).toBe(deployment);
    expect(await getGatewayForOrganization(null, STRIPE)).toBe(deployment);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe("planCaptureMode — the change a request makes, or a refusal", () => {
  const PLANS: {
    what: string;
    stored: unknown;
    requested: CaptureMode;
    payments: PaymentsConfig | null | undefined;
    allowAutomatic: boolean;
    plan: CaptureModePlan;
  }[] = [
    {
      what: "Rental Confirmation, nothing stored → MANUAL: a change, and no gateway is left charging at checkout",
      stored: undefined, requested: MANUAL, payments: RENTAL_NO_LIST, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] },
    },
    {
      what: "Rental Confirmation with the empty default list, null stored → MANUAL: a change",
      stored: null, requested: MANUAL, payments: RENTAL_EMPTY_LIST, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] },
    },
    {
      what: "Rental Confirmation listing [STRIPE], AUTOMATIC stored → MANUAL: a change",
      stored: "AUTOMATIC", requested: MANUAL, payments: RENTAL_LISTED, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] },
    },
    {
      what: "nothing stored → AUTOMATIC: no change, so an explicit AUTOMATIC is never written",
      stored: undefined, requested: AUTOMATIC, payments: RENTAL_NO_LIST, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: AUTOMATIC, changes: false, unaffectedGateways: [] },
    },
    {
      what: "null stored → AUTOMATIC: no change",
      stored: null, requested: AUTOMATIC, payments: RENTAL_LISTED, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: AUTOMATIC, changes: false, unaffectedGateways: [] },
    },
    {
      what: "AUTOMATIC stored → AUTOMATIC: no change",
      stored: "AUTOMATIC", requested: AUTOMATIC, payments: RENTAL_LISTED, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: AUTOMATIC, changes: false, unaffectedGateways: [] },
    },
    {
      what: "GlobeVista, MANUAL stored → MANUAL: no change",
      stored: "MANUAL", requested: MANUAL, payments: GLOBEVISTA, allowAutomatic: false,
      plan: { before: MANUAL, after: MANUAL, changes: false, unaffectedGateways: [] },
    },
    {
      what: "TripReservations (PayPal + Stripe) → MANUAL: allowed, and its PayPal links keep charging at checkout",
      stored: undefined, requested: MANUAL, payments: TRIP_RESERVATIONS, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [PAYPAL] },
    },
    {
      what: "TripReservations already MANUAL → MANUAL: no change, PayPal still reported",
      stored: "MANUAL", requested: MANUAL, payments: TRIP_RESERVATIONS, allowAutomatic: false,
      plan: { before: MANUAL, after: MANUAL, changes: false, unaffectedGateways: [PAYPAL] },
    },
    {
      what: "TripReservations → AUTOMATIC: unaffected gateways are reported for MANUAL only",
      stored: undefined, requested: AUTOMATIC, payments: TRIP_RESERVATIONS, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: AUTOMATIC, changes: false, unaffectedGateways: [] },
    },
    {
      what: "every non-Stripe gateway is reported as unaffected, in stored order",
      stored: undefined, requested: MANUAL, payments: frozen({ provider: STRIPE, enabledProviders: [RAZORPAY, STRIPE, PAYPAL] }), allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [RAZORPAY, PAYPAL] },
    },
    {
      what: "MANUAL → AUTOMATIC with allowAutomatic: a change",
      stored: "MANUAL", requested: AUTOMATIC, payments: GLOBEVISTA, allowAutomatic: true,
      plan: { before: MANUAL, after: AUTOMATIC, changes: true, unaffectedGateways: [] },
    },
    {
      what: "allowAutomatic makes no difference to any other switch",
      stored: undefined, requested: MANUAL, payments: RENTAL_LISTED, allowAutomatic: true,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] },
    },
    {
      what: "a PayPal-only brand → AUTOMATIC: never refused for lacking Stripe",
      stored: undefined, requested: AUTOMATIC, payments: PAYPAL_ONLY, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: AUTOMATIC, changes: false, unaffectedGateways: [] },
    },
    {
      what: "no payments object at all → MANUAL: such an organization pays through Stripe",
      stored: undefined, requested: MANUAL, payments: undefined, allowAutomatic: false,
      plan: { before: AUTOMATIC, after: MANUAL, changes: true, unaffectedGateways: [] },
    },
  ];
  for (const { what, stored, requested, payments, allowAutomatic, plan } of PLANS) {
    it(what, () => {
      expect(planCaptureMode({ stored, requested, payments, allowAutomatic })).toStrictEqual(plan);
    });
  }

  const NO_STRIPE: { what: string; payments: PaymentsConfig; stored: unknown; enabled: string }[] = [
    { what: "a PayPal-only brand", payments: PAYPAL_ONLY, stored: undefined, enabled: "PAYPAL" },
    { what: "a PayPal provider with no list", payments: frozen({ provider: PAYPAL }), stored: undefined, enabled: "PAYPAL" },
    { what: "two gateways, neither of them Stripe", payments: frozen({ provider: PAYPAL, enabledProviders: [PAYPAL, RAZORPAY] }), stored: undefined, enabled: "PAYPAL, RAZORPAY" },
    { what: "a PayPal-only brand that somehow already stores MANUAL", payments: PAYPAL_ONLY, stored: "MANUAL", enabled: "PAYPAL" },
  ];
  for (const { what, payments, stored, enabled } of NO_STRIPE) {
    it(`refuses MANUAL for ${what}, naming the gateways it does take (${enabled})`, () => {
      for (const allowAutomatic of [false, true]) {
        const err = caught(() => planCaptureMode({ stored, requested: MANUAL, payments, allowAutomatic }));
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe(NOT_STRIPE_MESSAGE(enabled));
      }
    });
  }

  it("refuses MANUAL → AUTOMATIC unless ALLOW_AUTOMATIC=1 confirms it", () => {
    for (const payments of [GLOBEVISTA, RENTAL_NO_LIST, TRIP_RESERVATIONS]) {
      const err = caught(() =>
        planCaptureMode({ stored: "MANUAL", requested: AUTOMATIC, payments, allowAutomatic: false }),
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(ALLOW_AUTOMATIC_MESSAGE);
      expect((err as Error).message).toMatch(/ALLOW_AUTOMATIC=1/);
    }
  });

  const INVALID: { stored: unknown; shown: string }[] = [
    { stored: "manual", shown: '"manual"' },
    { stored: "AUTO", shown: '"AUTO"' },
    { stored: "", shown: '""' },
    { stored: 1, shown: "1" },
    { stored: {}, shown: "{}" },
  ];
  for (const { stored, shown } of INVALID) {
    it(`refuses to plan over the stored ${shown}, whatever is requested`, () => {
      for (const requested of [AUTOMATIC, MANUAL]) {
        for (const allowAutomatic of [false, true]) {
          const err = caught(() =>
            planCaptureMode({ stored, requested, payments: RENTAL_LISTED, allowAutomatic }),
          );
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toBe(OVERWRITE_MESSAGE(shown));
        }
      }
    });
  }
});

describe("stripeWebhookPath — where an organization's Stripe events are delivered", () => {
  const ROWS: { what: string; org: { slug: string; isDefault?: boolean | null }; expected: string }[] = [
    { what: "the DEFAULT organization (Rental Confirmation) keeps the deployment endpoint", org: RENTAL, expected: "/api/webhooks/stripe" },
    { what: "the default organization's slug plays no part", org: { slug: "anything", isDefault: true }, expected: "/api/webhooks/stripe" },
    { what: "a non-default organization has its own endpoint", org: { slug: "globevista", isDefault: false }, expected: "/api/webhooks/stripe/globevista" },
    { what: "no isDefault stored means not the default", org: { slug: "tripreservations" }, expected: "/api/webhooks/stripe/tripreservations" },
    { what: "a null isDefault means not the default", org: { slug: "coastaltrips", isDefault: null }, expected: "/api/webhooks/stripe/coastaltrips" },
  ];
  for (const { what, org, expected } of ROWS) {
    it(`${what}: ${expected}`, () => {
      expect(stripeWebhookPath(org)).toBe(expected);
    });
  }

  it("names real POST routes: the deployment endpoint, and one [orgSlug] segment that no static folder can shadow", () => {
    const stripeDir = path.resolve(process.cwd(), "src/app", ...stripeWebhookPath(RENTAL).split("/").filter(Boolean));
    expect(path.relative(process.cwd(), stripeDir)).toBe(path.join("src", "app", "api", "webhooks", "stripe"));
    expect(readRepoFile("src/app/api/webhooks/stripe/route.ts")).toMatch(/export async function POST\(/);

    const folders = fs
      .readdirSync(stripeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(folders).toEqual(["[orgSlug]"]);
    expect(readRepoFile("src/app/api/webhooks/stripe/[orgSlug]/route.ts")).toMatch(/export async function POST\(/);

    // A non-default organization's path is that one dynamic segment, filled in.
    const perOrg = stripeWebhookPath({ slug: "globevista", isDefault: false });
    expect(path.posix.dirname(perOrg)).toBe(stripeWebhookPath(RENTAL));
    expect(path.posix.basename(perOrg)).toBe("globevista");
  });

  it("is the endpoint scripts/seed-globevista.ts tells GlobeVista's operator to register", () => {
    const source = readRepoFile("scripts/seed-globevista.ts");
    const slug = /const SLUG = "([^"]+)";/.exec(source)?.[1];
    const printedPrefix = /<APP_URL>(\/[^$`]+\/)\$\{SLUG\}/.exec(source)?.[1];
    expect(slug).toBe("globevista");
    expect(printedPrefix).toBe("/api/webhooks/stripe/");
    expect(stripeWebhookPath({ slug: String(slug), isDefault: false })).toBe(`${printedPrefix}${slug}`);
  });
});

describe("MANUAL_CAPTURE_STRIPE_EVENTS — what the endpoint must be subscribed to", () => {
  /** The events seed-globevista prints, read from its console.log lines,
   *  with "charge.dispute.created/updated/closed/funds_withdrawn" expanded. */
  function eventsSeedGlobeVistaPrints(): string[] {
    const source = readRepoFile("scripts/seed-globevista.ts");
    const printed = [...source.matchAll(/console\.log\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const first = printed.findIndex((line) => line.includes("required Stripe events:"));
    const end = printed.findIndex((line, i) => i > first && line.includes("(without"));
    expect(first, "the 'required Stripe events:' line").toBeGreaterThanOrEqual(0);
    expect(end, "the '(without …)' line that closes the list").toBeGreaterThan(first);

    const tokens = printed
      .slice(first, end)
      .join(" ")
      .replace(/^.*required Stripe events:/, "")
      .split(/[\s,]+/)
      .filter(Boolean);
    return tokens.flatMap((token) => {
      const [head, ...shorthand] = token.split("/");
      const prefix = head.slice(0, head.lastIndexOf("."));
      return [head, ...shorthand.map((tail) => `${prefix}.${tail}`)];
    });
  }

  it("are exactly the events scripts/seed-globevista.ts prints, with no duplicates", () => {
    const printed = eventsSeedGlobeVistaPrints();
    // The reference, absolutely: what the seed prints today.
    expect(printed).toEqual([
      "checkout.session.completed",
      "checkout.session.expired",
      "payment_intent.amount_capturable_updated",
      "payment_intent.succeeded",
      "payment_intent.canceled",
      "payment_intent.payment_failed",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "charge.dispute.funds_withdrawn",
    ]);
    for (const event of printed) expect(event).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);

    // The list, against it.
    expect([...MANUAL_CAPTURE_STRIPE_EVENTS].sort()).toEqual([...printed].sort());
    expect(new Set(MANUAL_CAPTURE_STRIPE_EVENTS).size).toBe(MANUAL_CAPTURE_STRIPE_EVENTS.length);
    expect(MANUAL_CAPTURE_STRIPE_EVENTS).toHaveLength(11);
  });

  describe("each one is handled by the real Stripe webhook adapter", () => {
    const WEBHOOK_SECRET = "whsec_capture_mode_unit";
    const SECRET_KEY = "sk_test_capture_mode_unit";
    const HOLD = {
      orderId: "64b7f0c2a1b2c3d4e5f60719",
      orderNumber: "ORD-CAPTURE-0001",
      paymentIntentId: "pi_test_capture_mode_hold",
    };

    beforeEach(() => {
      // The real Stripe SDK verifies the signature, not the test stub.
      vi.stubEnv("PAYOPS_TEST_MODE", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function stripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
      return {
        id: `evt_test_${type.replace(/\./g, "_")}`,
        object: "event",
        api_version: "2024-06-20",
        created: Math.floor(Date.now() / 1000),
        type,
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object },
      } as unknown as Stripe.Event;
    }

    function dispute(status: string): Record<string, unknown> {
      return {
        id: "dp_test_capture_mode",
        object: "dispute",
        charge: "ch_test_capture_mode",
        payment_intent: HOLD.paymentIntentId,
        status,
        reason: "fraudulent",
        amount: 24999,
        currency: "usd",
        evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
      };
    }

    function stripeGateway() {
      return createStripeGateway(() => ({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET }));
    }

    /** What the adapter makes of `event`, delivered signed the way Stripe signs it. */
    async function adapterReads(event: Stripe.Event): Promise<{ stripeType: string; type: PaymentEventType }> {
      // Every read, not only the guard test below: the real SDK verifies it.
      expect(getStripeFor(SECRET_KEY)).toBeInstanceOf(Stripe);
      const payload = JSON.stringify(event);
      const signature = signWebhook(payload, WEBHOOK_SECRET);
      const verified = await stripeGateway().verifyWebhook(payload, {
        get: (name) => (name === "stripe-signature" ? signature : null),
      });
      return { stripeType: (verified.raw as Stripe.Event).type, type: verified.type };
    }

    /** One event per subscribed type, as Stripe sends it for a manual-capture
     *  hold. Keyed by the list's own type: a new entry without a row does
     *  not compile. */
    const LIFECYCLE: Record<
      (typeof MANUAL_CAPTURE_STRIPE_EVENTS)[number],
      { event: () => Stripe.Event; becomes: PaymentEventType }
    > = {
      "checkout.session.completed": {
        // Under manual capture Stripe completes the session "unpaid".
        event: () => buildCheckoutCompleted({ ...HOLD, paymentStatus: "unpaid" }),
        becomes: "payment.authorized",
      },
      "checkout.session.expired": { event: () => buildCheckoutExpired(HOLD), becomes: "checkout.expired" },
      "payment_intent.amount_capturable_updated": {
        event: () => buildAmountCapturableUpdated(HOLD),
        becomes: "payment.authorized",
      },
      "payment_intent.succeeded": { event: () => buildPaymentIntentSucceeded(HOLD), becomes: "payment.captured" },
      "payment_intent.canceled": {
        // The hold Stripe let lapse after ~7 days.
        event: () => buildPaymentIntentCanceled({ ...HOLD, cancellationReason: "automatic" }),
        becomes: "payment.cancelled",
      },
      "payment_intent.payment_failed": {
        event: () => buildPaymentIntentFailed({ paymentIntentId: HOLD.paymentIntentId }),
        becomes: "payment.failed",
      },
      "charge.refunded": {
        event: () =>
          stripeEvent("charge.refunded", {
            id: "ch_test_capture_mode",
            object: "charge",
            amount: 24999,
            amount_refunded: 24999,
            currency: "usd",
            payment_intent: HOLD.paymentIntentId,
            metadata: { orderId: HOLD.orderId },
            refunds: { data: [{ id: "re_test_capture_mode", amount: 24999, reason: "requested_by_customer" }] },
          }),
        becomes: "refund.created",
      },
      "charge.dispute.created": {
        event: () => stripeEvent("charge.dispute.created", dispute("needs_response")),
        becomes: "dispute.created",
      },
      "charge.dispute.updated": {
        event: () => stripeEvent("charge.dispute.updated", dispute("under_review")),
        becomes: "dispute.updated",
      },
      "charge.dispute.closed": {
        event: () => stripeEvent("charge.dispute.closed", dispute("lost")),
        becomes: "dispute.closed",
      },
      "charge.dispute.funds_withdrawn": {
        event: () => stripeEvent("charge.dispute.funds_withdrawn", dispute("needs_response")),
        becomes: "dispute.funds_withdrawn",
      },
    };

    it("runs the real Stripe signature check: an event signed with another endpoint's secret is refused", async () => {
      expect(getStripeFor(SECRET_KEY)).toBeInstanceOf(Stripe);
      const payload = JSON.stringify(buildAmountCapturableUpdated(HOLD));
      const forged = signWebhook(payload, "whsec_another_endpoint");
      await expect(
        Promise.resolve().then(() =>
          stripeGateway().verifyWebhook(payload, {
            get: (name) => (name === "stripe-signature" ? forged : null),
          }),
        ),
      ).rejects.toThrow(/No signatures found matching the expected signature/);
    });

    for (const type of MANUAL_CAPTURE_STRIPE_EVENTS) {
      const { event, becomes } = LIFECYCLE[type];
      it(`${type} reaches the app as ${becomes}`, async () => {
        const read = await adapterReads(event());
        expect(read.stripeType).toBe(type);
        expect(read.type).toBe(becomes);
        expect(read.type).not.toBe("unhandled");
      });
    }

    it("of its PaymentIntent events, only payment_intent.payment_failed also acts on a charge-at-checkout payment — the one the script warns about", async () => {
      // amount_capturable_updated is not gated on capture_method, but Stripe
      // sends it only for a manual-capture PaymentIntent.
      const automatic = { ...HOLD, captureMethod: "automatic" as const };
      expect((await adapterReads(buildPaymentIntentSucceeded(automatic))).type).toBe("unhandled");
      expect((await adapterReads(buildPaymentIntentCanceled(automatic))).type).toBe("unhandled");
      const declinedAtCheckout = stripeEvent("payment_intent.payment_failed", {
        id: HOLD.paymentIntentId,
        object: "payment_intent",
        capture_method: "automatic",
        status: "requires_payment_method",
        last_payment_error: { message: "Your card was declined." },
      });
      expect((await adapterReads(declinedAtCheckout)).type).toBe("payment.failed");
      // One checkout.session.completed subscription serves both modes: the
      // session's own payment_status decides which way it goes.
      expect((await adapterReads(buildCheckoutCompleted({ ...HOLD, paymentStatus: "paid" }))).type).toBe(
        "checkout.completed",
      );
    });
  });
});
