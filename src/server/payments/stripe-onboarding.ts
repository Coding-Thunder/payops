import "server-only";

import type Stripe from "stripe";

import { GatewayMode } from "@/server/db/models";

import { getStripeForSecret } from "./stripe";

/**
 * Pass 6a, Stripe onboarding helpers.
 *
 * Goal: cut the gateway-setup ritual ("paste secret → go to Stripe →
 * register webhook → paste resulting whsec back here") down to a
 * single "paste your Stripe secret key" step. We use the operator's
 * secret to call Stripe ourselves: verify the key, register the
 * webhook endpoint, capture the returned signing secret. They never
 * leave our admin page.
 *
 * Why this is safe: the secret key the operator pastes IS the
 * authorization. With it we can do whatever Stripe lets account-level
 * keys do, including managing webhook endpoints. We never store the
 * key in plaintext beyond the request lifetime; the encryption + audit
 * trail in `gateway-credentials.service.ts` is unchanged.
 */

/** Events TraceTxn subscribes to. Mirrors `mapStripeEventType` in
 *  `gateways/stripe.ts`, any new event handled there must be added
 *  here so newly-registered endpoints actually receive it. */
export const TRACETXN_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
  "checkout.session.async_payment_failed",
  "payment_intent.payment_failed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.refunded",
] as const;

export type StripeKeyVerification = {
  ok: true;
  livemode: boolean;
  detectedMode: GatewayMode;
  /** Stripe account id if the key exposes it (Connect / direct). */
  accountId: string | null;
};

export interface StripeVerificationError {
  ok: false;
  code:
    | "AUTH_FAILED"
    | "MODE_MISMATCH"
    | "PERMISSION_DENIED"
    | "NETWORK_FAILURE"
    | "UNKNOWN";
  message: string;
}

/**
 * Hit Stripe's `/v1/balance` with the operator's key. Succeeds with
 * `livemode` so the caller can flag a TEST-vs-LIVE mismatch before
 * persisting. Auth failures surface as a friendly error rather than a
 * raw Stripe exception.
 */
export async function verifyStripeSecret(
  secretKey: string,
  expectedMode?: GatewayMode,
): Promise<StripeKeyVerification | StripeVerificationError> {
  const detectedMode: GatewayMode = secretKey.startsWith("sk_test_")
    ? GatewayMode.TEST
    : secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")
      ? GatewayMode.LIVE
      : GatewayMode.TEST;

  if (expectedMode && expectedMode !== detectedMode) {
    return {
      ok: false,
      code: "MODE_MISMATCH",
      message: `Key prefix says ${detectedMode} but you selected ${expectedMode}. Pick the matching mode or paste the right key.`,
    };
  }

  const stripe = getStripeForSecret(secretKey);
  try {
    const balance = await stripe.balance.retrieve();
    return {
      ok: true,
      livemode: Boolean(balance.livemode),
      detectedMode,
      accountId: extractAccountId(balance),
    };
  } catch (err) {
    return mapStripeError(err);
  }
}

/**
 * Register TraceTxn as a webhook endpoint on the operator's Stripe
 * account. Idempotent: if an endpoint with the same callback URL
 * already exists we re-use it. Returns the endpoint id + the freshly
 * minted signing secret.
 *
 * NOTE: Stripe surfaces the signing secret on `endpoint.secret` ONLY
 * on the `create` call. Re-listing later never returns it. So once
 * the operator's `secret` is encrypted into our DB the only way to
 * recover it is to recreate the endpoint.
 */
export interface RegisteredWebhookEndpoint {
  endpointId: string;
  signingSecret: string;
  /** URL we asked Stripe to deliver to. */
  url: string;
}

export async function registerStripeWebhookEndpoint(args: {
  secretKey: string;
  callbackUrl: string;
}): Promise<RegisteredWebhookEndpoint> {
  const stripe = getStripeForSecret(args.secretKey);

  // Dedup: re-use an existing endpoint with the same URL. Avoids
  // accumulating dangling endpoints when an admin re-saves the same
  // org's credentials over and over.
  try {
    const existing = await stripe.webhookEndpoints.list({ limit: 100 });
    const match = existing.data.find((ep) => ep.url === args.callbackUrl);
    if (match && match.secret) {
      return {
        endpointId: match.id,
        signingSecret: match.secret,
        url: match.url,
      };
    }
    // If the match exists but has no `secret` exposed (older endpoint
    // created out-of-band), drop and re-create so we get a usable secret.
    if (match) {
      try {
        await stripe.webhookEndpoints.del(match.id);
      } catch {
        // Best-effort. If we can't delete we create alongside.
      }
    }
  } catch {
    // List failed (permissions?), fall through to create.
  }

  const created = await stripe.webhookEndpoints.create({
    url: args.callbackUrl,
    enabled_events: [
      ...TRACETXN_STRIPE_EVENTS,
    ] as unknown as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
    description: "TraceTxn, auto-registered by the admin onboarding flow.",
  });
  if (!created.secret) {
    throw new Error(
      "Stripe accepted the endpoint but did not return a signing secret. Retry, or paste credentials manually as a fallback.",
    );
  }
  return {
    endpointId: created.id,
    signingSecret: created.secret,
    url: created.url,
  };
}

/**
 * Tear down the webhook endpoint we created when the operator disables
 * the credential. Best-effort: a failure here doesn't block the
 * disable (the encrypted secret is gone anyway), but it does leave a
 * dangling endpoint on Stripe's side that the operator should clean
 * up manually.
 */
export async function deleteStripeWebhookEndpoint(args: {
  secretKey: string;
  endpointId: string;
}): Promise<void> {
  const stripe = getStripeForSecret(args.secretKey);
  await stripe.webhookEndpoints.del(args.endpointId);
}

/* ───────────────────────────── Helpers ──────────────────────────────── */

function extractAccountId(balance: Stripe.Balance): string | null {
  const maybe = (balance as unknown as { account?: string }).account;
  return typeof maybe === "string" ? maybe : null;
}

function mapStripeError(err: unknown): StripeVerificationError {
  const e = err as { type?: string; code?: string; message?: string } | null;
  if (!e || typeof e !== "object") {
    return { ok: false, code: "UNKNOWN", message: "Unknown error" };
  }
  if (e.type === "StripeAuthenticationError" || e.code === "invalid_api_key") {
    return {
      ok: false,
      code: "AUTH_FAILED",
      message:
        "Stripe rejected this secret key. Double-check that you copied the whole value from the Stripe dashboard.",
    };
  }
  if (e.type === "StripePermissionError") {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      message:
        "This key doesn't have permission to read balance. Use an unrestricted secret key, not a restricted one (rk_).",
    };
  }
  if (e.type === "StripeConnectionError") {
    return {
      ok: false,
      code: "NETWORK_FAILURE",
      message: "Couldn't reach Stripe. Check your network and try again.",
    };
  }
  return {
    ok: false,
    code: "UNKNOWN",
    message: e.message ?? "Stripe returned an unexpected error.",
  };
}

/**
 * Build the canonical per-org Stripe webhook callback URL we register
 * with Stripe. Centralised here so the service + tests use the same
 * value and the admin UI can preview it.
 */
export function buildStripeWebhookCallbackUrl(
  appUrl: string,
  orgId: string,
): string {
  return `${appUrl.replace(/\/$/, "")}/api/webhooks/stripe/${orgId}`;
}

/* ──────────────────── Verify + repair (admin diagnostics) ─────────────────── */

export type WebhookHealthStatus =
  /** Endpoint found at our callback URL, status=enabled, all required
   *  events subscribed. */
  | "healthy"
  /** Endpoint found but some required events missing. UI exposes a
   *  "Repair" affordance to backfill them in-place. */
  | "missing_events"
  /** Endpoint exists but Stripe has it disabled. Common when an
   *  operator paused it from the Stripe dashboard. */
  | "disabled"
  /** No endpoint at our callback URL. Either the operator deleted it
   *  from Stripe, or we never finished the connect flow. */
  | "not_found"
  /** Stripe rejected our key, auth failure, revoked key, etc. */
  | "auth_failed"
  /** Couldn't reach Stripe at all. */
  | "unreachable";

export interface WebhookHealthReport {
  status: WebhookHealthStatus;
  /** Stripe webhook endpoint id when present. */
  endpointId: string | null;
  /** Callback URL we expected to find. Always populated so the UI
   *  can show it next to the diagnostic. */
  expectedUrl: string;
  /** Live mode flag from the Stripe account (mismatch between this
   *  and our stored GatewayMode is surfaced as a warning). */
  livemode: boolean | null;
  /** Events the endpoint is currently subscribed to (sorted). */
  subscribedEvents: string[];
  /** Events TraceTxn relies on that are NOT on the endpoint. */
  missingEvents: string[];
  /** Events subscribed but not in TraceTxn's required list, only
   *  informational. Doesn't block "healthy" status. */
  extraEvents: string[];
  /** Human-readable summary for surfacing in the UI alert. */
  summary: string;
}

/** Sort + dedupe. Stripe returns events in registration order which
 *  isn't useful for UI diffing. */
function normalize(events: readonly string[]): string[] {
  return Array.from(new Set(events)).sort();
}

/**
 * Probe the operator's Stripe account: confirm the key still works,
 * find our webhook endpoint at the canonical URL, diff its subscribed
 * events against TRACETXN_STRIPE_EVENTS. Returns a structured report
 * the admin UI renders verbatim.
 *
 * Pure read, no mutation. Repair lives in `repairStripeWebhookEvents`.
 */
export async function verifyStripeWebhookHealth(args: {
  secretKey: string;
  callbackUrl: string;
}): Promise<WebhookHealthReport> {
  const required = normalize(TRACETXN_STRIPE_EVENTS);
  const base: WebhookHealthReport = {
    status: "unreachable",
    endpointId: null,
    expectedUrl: args.callbackUrl,
    livemode: null,
    subscribedEvents: [],
    missingEvents: [...required],
    extraEvents: [],
    summary: "",
  };

  const stripe = getStripeForSecret(args.secretKey);

  // 1. Key health probe, same call we use during initial verify so
  // failure modes surface identically.
  let livemode: boolean | null = null;
  try {
    const balance = await stripe.balance.retrieve();
    livemode = Boolean(balance.livemode);
  } catch (err) {
    const mapped = mapStripeError(err);
    return {
      ...base,
      status:
        mapped.code === "AUTH_FAILED" || mapped.code === "PERMISSION_DENIED"
          ? "auth_failed"
          : "unreachable",
      livemode: null,
      summary: mapped.message,
    };
  }

  // 2. List webhooks + find ours by URL.
  let endpoint: Stripe.WebhookEndpoint | null = null;
  try {
    const all = await stripe.webhookEndpoints.list({ limit: 100 });
    endpoint = all.data.find((ep) => ep.url === args.callbackUrl) ?? null;
  } catch (err) {
    const mapped = mapStripeError(err);
    return {
      ...base,
      status: "unreachable",
      livemode,
      summary: `Couldn't list Stripe webhooks: ${mapped.message}`,
    };
  }

  if (!endpoint) {
    return {
      ...base,
      status: "not_found",
      livemode,
      summary:
        "No Stripe webhook is registered for this workspace yet. Click Repair to register one.",
    };
  }

  const subscribed = normalize(endpoint.enabled_events ?? []);
  // "*" means "all events", Stripe accepts it as a wildcard; treat
  // it as covering every required event.
  const isWildcard = subscribed.includes("*");
  const missing = isWildcard
    ? []
    : required.filter((e) => !subscribed.includes(e));
  const extra = subscribed.filter(
    (e) => e !== "*" && !required.includes(e),
  );

  if (endpoint.status === "disabled") {
    return {
      ...base,
      status: "disabled",
      endpointId: endpoint.id,
      livemode,
      subscribedEvents: subscribed,
      missingEvents: missing,
      extraEvents: extra,
      summary:
        "Stripe shows this endpoint as disabled. Re-enable it in the Stripe dashboard, or re-connect from TraceTxn to register a fresh one.",
    };
  }

  if (missing.length > 0) {
    return {
      ...base,
      status: "missing_events",
      endpointId: endpoint.id,
      livemode,
      subscribedEvents: subscribed,
      missingEvents: missing,
      extraEvents: extra,
      summary: `Webhook is live but missing ${missing.length} event${
        missing.length === 1 ? "" : "s"
      } TraceTxn relies on. Click Repair to add them.`,
    };
  }

  return {
    ...base,
    status: "healthy",
    endpointId: endpoint.id,
    livemode,
    subscribedEvents: subscribed,
    missingEvents: [],
    extraEvents: extra,
    summary: `Webhook is live and subscribed to all ${required.length} events TraceTxn needs.`,
  };
}

/**
 * Backfill missing events onto an existing webhook endpoint in place.
 * Idempotent: re-running is safe; Stripe accepts the full event list
 * and just updates `enabled_events` to that set.
 *
 * Does NOT change the endpoint id or signing secret, so our encrypted
 * webhookSecret in `gateway_credentials` keeps validating signatures.
 */
export async function repairStripeWebhookEvents(args: {
  secretKey: string;
  endpointId: string;
}): Promise<{ subscribedEvents: string[] }> {
  const stripe = getStripeForSecret(args.secretKey);
  const updated = await stripe.webhookEndpoints.update(args.endpointId, {
    enabled_events: [
      ...TRACETXN_STRIPE_EVENTS,
    ] as unknown as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
  });
  return { subscribedEvents: normalize(updated.enabled_events ?? []) };
}
