import {
  CAPTURE_MODES,
  CaptureMode,
  PaymentGatewayKey,
} from "@/lib/constants/enums";

/**
 * Whether an organization's Stripe payments are charged at checkout
 * (AUTOMATIC) or authorized and captured by an operator later (MANUAL) —
 * the pure rules behind `scripts/set-organization-capture-mode.ts`.
 *
 * Deliberately free of server-only imports so the operations script and
 * tests share ONE definition, the way `organization-service-types.ts` does
 * for `scripts/set-organization-services.ts`.
 */

/** Thrown for a value that is not a capture mode — nothing is guessed. */
export class UnknownCaptureModeError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(`Unknown capture mode: ${value}. Use ${CAPTURE_MODES.join(" or ")}.`);
    this.name = "UnknownCaptureModeError";
    this.value = value;
  }
}

function isCaptureMode(value: string): value is CaptureMode {
  return (CAPTURE_MODES as string[]).includes(value);
}

/**
 * A requested capture mode ("manual", " MANUAL ") as a CaptureMode:
 * trimmed and upper-cased. Blank or anything else is refused, never
 * ignored — a typo must not quietly leave the organization as it was.
 */
export function parseCaptureMode(raw: string | null | undefined): CaptureMode {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) {
    throw new Error(`Set CAPTURE_MODE to ${CAPTURE_MODES.join(" or ")}.`);
  }
  if (!isCaptureMode(value)) throw new UnknownCaptureModeError(value);
  return value;
}

/**
 * What an organization runs on TODAY: its stored mode, or AUTOMATIC when
 * none is stored — `.lean()` reads apply no schema defaults, and a document
 * stored before the field existed has no such key at all (the same rule as
 * `getOrganizationCaptureMode`). A stored value that is not a capture mode
 * is refused rather than overwritten blind.
 */
export function captureModeOrDefault(stored: unknown): CaptureMode {
  if (stored === undefined || stored === null) return CaptureMode.AUTOMATIC;
  if (typeof stored === "string" && isCaptureMode(stored)) return stored;
  throw new Error(
    `The stored capture mode ${JSON.stringify(stored)} is not ${CAPTURE_MODES.join(" or ")} — refusing to overwrite it.`,
  );
}

export interface PaymentsConfig {
  provider?: string | null;
  enabledProviders?: readonly string[] | null;
}

/**
 * The gateways an organization's new payment links can use — exactly what
 * `getGatewayForOrganization` can reach: every provider in its enabled list
 * (an operator's pick among them is honoured), plus its configured provider
 * (STRIPE when none is stored), which a link with no pick — or a pick outside
 * the list — falls back to. With no list stored, that is the configured
 * provider alone.
 */
export function enabledGateways(payments: PaymentsConfig | null | undefined): string[] {
  const configured = payments?.provider ?? PaymentGatewayKey.STRIPE;
  const enabled =
    payments?.enabledProviders && payments.enabledProviders.length > 0
      ? [...payments.enabledProviders]
      : [];
  return enabled.includes(configured) ? enabled : [...enabled, configured];
}

export interface CaptureModePlan {
  before: CaptureMode;
  after: CaptureMode;
  /** False when the organization already runs `after`: nothing to write. */
  changes: boolean;
  /** Enabled gateways a MANUAL setting does not reach — their links keep
   *  charging at checkout (manual capture is Stripe-only). */
  unaffectedGateways: string[];
}

/**
 * The change `requested` makes to an organization, or a refusal.
 *
 * Refuses:
 *  - MANUAL for an organization that does not take Stripe payments. Link
 *    generation applies manual capture to Stripe only
 *    (`captureMode === MANUAL && gatewayKey === STRIPE`), so it would
 *    silently change nothing.
 *  - MANUAL → AUTOMATIC unless `allowAutomatic`. Orders already on the
 *    manual lifecycle keep it (live holds still need Capture or Release),
 *    and regenerating one of them after the switch leaves its manual
 *    capture state in place — a deliberate, confirmed step only.
 */
export function planCaptureMode(input: {
  stored: unknown;
  requested: CaptureMode;
  payments: PaymentsConfig | null | undefined;
  allowAutomatic: boolean;
}): CaptureModePlan {
  const before = captureModeOrDefault(input.stored);
  const gateways = enabledGateways(input.payments);

  if (
    input.requested === CaptureMode.MANUAL &&
    !gateways.includes(PaymentGatewayKey.STRIPE)
  ) {
    throw new Error(
      `This organization does not take Stripe payments (enabled: ${gateways.join(", ")}). Manual capture applies to Stripe only, so MANUAL would change nothing.`,
    );
  }
  if (
    before === CaptureMode.MANUAL &&
    input.requested === CaptureMode.AUTOMATIC &&
    !input.allowAutomatic
  ) {
    throw new Error(
      "Switching from MANUAL back to AUTOMATIC: orders already authorized keep the manual lifecycle (each still needs Capture or Release). Set ALLOW_AUTOMATIC=1 as well to confirm.",
    );
  }

  return {
    before,
    after: input.requested,
    changes: before !== input.requested,
    unaffectedGateways:
      input.requested === CaptureMode.MANUAL
        ? gateways.filter((g) => g !== PaymentGatewayKey.STRIPE)
        : [],
  };
}

/**
 * Where an organization's Stripe events must be delivered. The DEFAULT
 * organization keeps the deployment endpoint — it alone also owns orders
 * stored without an organization, which a per-organization endpoint
 * refuses — every other organization has its own.
 */
export function stripeWebhookPath(org: { slug: string; isDefault?: boolean | null }): string {
  return org.isDefault
    ? "/api/webhooks/stripe"
    : `/api/webhooks/stripe/${org.slug}`;
}

/**
 * The Stripe events the manual-capture lifecycle needs on that endpoint
 * (the list `scripts/seed-globevista.ts` prints). The authorization is also
 * recorded from an unpaid `checkout.session.completed`; the PaymentIntent
 * events carry captures and releases made outside the app, the hold
 * expiring after ~7 days, and capture declines.
 */
export const MANUAL_CAPTURE_STRIPE_EVENTS = [
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
] as const;
