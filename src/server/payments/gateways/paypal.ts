import "server-only";

import { logger } from "@/lib/logger";

import { toMinorUnits } from "../currency";
import type {
  CreatePaymentSessionInput,
  CreatedPaymentSession,
  PaymentEventType,
  PaymentGateway,
  SessionStatus,
  VerifiedPaymentEvent,
  WebhookHeaders,
} from "../gateway";

/**
 * PayPal implementation of `PaymentGateway` (Orders v2).
 *
 * PayPal differs from Stripe in three ways that shape this file:
 *
 *  1. AUTH IS A TOKEN, NOT A KEY. Every call needs a bearer token obtained
 *     from client-id/secret via OAuth. Tokens are cached per credential set
 *     until shortly before expiry.
 *
 *  2. WEBHOOKS HAVE NO SIGNING SECRET. Authenticity is established by
 *     calling PayPal back at /v1/notifications/verify-webhook-signature with
 *     five transmission headers and the webhook id. It is a network round
 *     trip that can fail, which is why `verifyWebhook` is async in the
 *     interface. A non-SUCCESS verdict is treated exactly like a bad Stripe
 *     signature: throw, and the route answers 400.
 *
 *  3. APPROVAL AND CAPTURE ARE SEPARATE. The buyer approving an order does
 *     NOT move money — `CHECKOUT.ORDER.APPROVED` only means "authorised to
 *     capture". Money moves on capture, reported by
 *     `PAYMENT.CAPTURE.COMPLETED`. Only the latter maps to
 *     "checkout.completed"; treating APPROVED as paid would mark orders paid
 *     that were never charged.
 */

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const LIVE_BASE = "https://api-m.paypal.com";

/** Network timeout. PayPal is in the request path for link generation, so a
 *  hung socket must not hold an operator's browser open indefinitely. */
const TIMEOUT_MS = 15_000;

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  /** From the webhook you registered in the PayPal app. Required to verify
   *  deliveries — without it authenticity cannot be established at all. */
  webhookId: string;
  /** true => api-m.sandbox.paypal.com */
  sandbox: boolean;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
const tokenCache = new Map<string, CachedToken>();

/** Test seam mirroring `setStripeForTesting`: lets tests drive the HTTP
 *  layer without a network. Production never calls this. */
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function _setPayPalFetchForTesting(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...args) => fetch(...args));
  tokenCache.clear();
}

function baseUrl(c: PayPalCredentials): string {
  return c.sandbox ? SANDBOX_BASE : LIVE_BASE;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** OAuth bearer token, cached until 60s before expiry. */
async function accessToken(c: PayPalCredentials): Promise<string> {
  const key = `${c.sandbox ? "s" : "l"}:${c.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.token;

  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await withTimeout((signal) =>
    fetchImpl(`${baseUrl(c)}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal,
    }),
  );
  if (!res.ok) {
    // Deliberately does not include the response body: PayPal echoes the
    // client id on some auth errors.
    throw new Error(`PayPal auth failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.max(0, (json.expires_in - 60) * 1000),
  });
  return json.access_token;
}

async function api<T>(
  c: PayPalCredentials,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const token = await accessToken(c);
  const res = await withTimeout((signal) =>
    fetchImpl(`${baseUrl(c)}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    }),
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PayPal ${init.method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * PayPal event name -> our normalised lifecycle event.
 *
 * CHECKOUT.ORDER.APPROVED is deliberately NOT "checkout.completed": approval
 * authorises a capture, it does not move money. Mapping it to completed
 * would mark orders paid that were never charged.
 */
function mapPayPalEventType(type: string): PaymentEventType {
  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return "checkout.completed";
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED":
      return "payment.failed";
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED":
      return "refund.created";
    case "CUSTOMER.DISPUTE.CREATED":
      return "dispute.created";
    case "CUSTOMER.DISPUTE.UPDATED":
      return "dispute.updated";
    case "CUSTOMER.DISPUTE.RESOLVED":
      return "dispute.closed";
    case "CHECKOUT.ORDER.APPROVED":
    default:
      return "unhandled";
  }
}

/** Minor units from PayPal's decimal string, e.g. "249.99" -> 24999. */
function amountToMinor(value: string | undefined, currency: string): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return toMinorUnits(n, currency);
}

/**
 * A gateway that additionally supports an explicit capture step.
 *
 * Kept OFF the shared PaymentGateway contract on purpose: Stripe Checkout
 * captures inside its hosted flow and has no equivalent, so putting
 * `captureOrder` on the interface would force a method onto every
 * implementation that only PayPal can meaningfully provide. Callers
 * feature-detect with `supportsCapture()`.
 */
export interface CapturingPaymentGateway extends PaymentGateway {
  captureOrder(sessionId: string): Promise<void>;
}

/** Type guard for the optional capture capability. */
export function supportsCapture(
  gateway: PaymentGateway,
): gateway is CapturingPaymentGateway {
  return (
    typeof (gateway as Partial<CapturingPaymentGateway>).captureOrder ===
    "function"
  );
}

export function createPayPalGateway(
  credentials: () => PayPalCredentials,
): CapturingPaymentGateway {
  return {
    key: "PAYPAL",
    label: "PayPal",
    get enabled() {
      const c = credentials();
      return Boolean(c.clientId && c.clientSecret && c.webhookId);
    },
    get sandbox() {
      return credentials().sandbox;
    },

    async createSession(
      input: CreatePaymentSessionInput,
    ): Promise<CreatedPaymentSession> {
      const c = credentials();
      const currency = input.currency.toUpperCase();

      const order = await api<{
        id: string;
        status: string;
        links?: { rel: string; href: string }[];
      }>(c, "/v2/checkout/orders", {
        method: "POST",
        headers: {
          // Same stable-key idea as the Stripe adapter: re-running this for
          // one order returns the original PayPal order instead of creating
          // a second one the customer could also pay.
          "PayPal-Request-Id": `order:${input.orderId}:checkout`,
        },
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              // Echoed back on every webhook, which is how the order is
              // recovered later — PayPal has no client_reference_id.
              custom_id: input.orderId,
              invoice_id: `${input.orderNumber}-${Date.now()}`,
              description: input.description.slice(0, 127),
              amount: {
                currency_code: currency,
                value: input.amount.toFixed(2),
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: input.metadata.appName ?? input.productName,
                user_action: "PAY_NOW",
                return_url: `${input.successUrl}?order=${encodeURIComponent(input.orderNumber)}`,
                cancel_url: `${input.cancelUrl}?order=${encodeURIComponent(input.orderNumber)}`,
              },
            },
          },
        },
      });

      const approve = order.links?.find(
        (l) => l.rel === "payer-action" || l.rel === "approve",
      );
      if (!approve?.href) {
        throw new Error("PayPal did not return an approval URL");
      }

      return {
        sessionId: order.id,
        url: approve.href,
        // PayPal has no payment-intent equivalent at create time; the
        // capture id arrives on the webhook.
        paymentIntentId: null,
        // PayPal orders expire after ~3 hours of inactivity and the API does
        // not report a precise time, so we echo the caller's intent.
        expiresAt: input.expiresAt,
      };
    },

    async expireSession(sessionId: string): Promise<void> {
      // PayPal exposes no cancel/void for an unapproved order — it lapses on
      // its own. Recorded rather than silently ignored so the lifecycle log
      // still shows the intent.
      logger.info("paypal.expire_session.noop", { sessionId });
    },

    async verifyWebhook(
      rawBody: string | Buffer,
      headers: WebhookHeaders,
    ): Promise<VerifiedPaymentEvent> {
      const c = credentials();
      const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

      const transmissionId = headers.get("paypal-transmission-id");
      const transmissionTime = headers.get("paypal-transmission-time");
      const certUrl = headers.get("paypal-cert-url");
      const authAlgo = headers.get("paypal-auth-algo");
      const transmissionSig = headers.get("paypal-transmission-sig");

      if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
        throw new Error("PayPal webhook is missing transmission headers");
      }
      // PayPal's own docs warn that cert_url must be validated before use —
      // it is echoed into a server-side fetch on their side, and accepting an
      // arbitrary host would let a forged delivery point verification at a
      // server the attacker controls.
      if (!/^https:\/\/api(-m)?(\.[a-z0-9-]+)*\.paypal\.com\//i.test(certUrl)) {
        throw new Error("PayPal webhook cert_url is not a paypal.com URL");
      }

      const parsed = JSON.parse(body) as {
        id: string;
        event_type: string;
        create_time?: string;
        resource?: Record<string, unknown>;
      };

      const verdict = await api<{ verification_status: string }>(
        c,
        "/v1/notifications/verify-webhook-signature",
        {
          method: "POST",
          body: {
            transmission_id: transmissionId,
            transmission_time: transmissionTime,
            cert_url: certUrl,
            auth_algo: authAlgo,
            transmission_sig: transmissionSig,
            webhook_id: c.webhookId,
            webhook_event: parsed,
          },
        },
      );
      if (verdict.verification_status !== "SUCCESS") {
        throw new Error("PayPal webhook signature verification failed");
      }

      const resource = (parsed.resource ?? {}) as Record<string, unknown>;
      const supplementary = resource.supplementary_data as
        | { related_ids?: { order_id?: string } }
        | undefined;
      const amount = resource.amount as
        | { currency_code?: string; value?: string }
        | undefined;

      // `custom_id` is what we set at create time; it round-trips our order
      // id on capture events. Dispute payloads nest it differently.
      const orderId =
        (resource.custom_id as string | undefined) ??
        ((resource.disputed_transactions as { custom?: string }[] | undefined)?.[0]
          ?.custom ??
          null);

      const currency = amount?.currency_code ?? "USD";

      return {
        eventId: parsed.id,
        type: mapPayPalEventType(parsed.event_type),
        // The PayPal ORDER id is our session id. On capture events it lives
        // under supplementary_data; on order events it is the resource id.
        sessionId:
          supplementary?.related_ids?.order_id ??
          (parsed.event_type.startsWith("CHECKOUT.ORDER.")
            ? ((resource.id as string | undefined) ?? null)
            : null),
        orderId,
        // The capture id is the closest analogue to a payment-intent: it is
        // the handle refunds and disputes reference.
        paymentIntentId: (resource.id as string | undefined) ?? null,
        amountTotalMinor: amountToMinor(amount?.value, currency),
        occurredAtMs: parsed.create_time
          ? Date.parse(parsed.create_time)
          : Date.now(),
        raw: parsed,
      };
    },

    /**
     * Capture an approved order — the step that actually moves money.
     *
     * PayPal-specific, so it is an extra method on this object rather than
     * part of the PaymentGateway contract; Stripe Checkout captures inside
     * its hosted flow and has no equivalent, and putting it on the shared
     * interface would force a method onto every gateway that only one can
     * implement. The PayPal webhook route feature-detects it.
     */
    async captureOrder(sessionId: string): Promise<void> {
      const c = credentials();
      await api(c, `/v2/checkout/orders/${encodeURIComponent(sessionId)}/capture`, {
        method: "POST",
        headers: {
          // Makes a duplicate APPROVED delivery a no-op on PayPal's side
          // rather than a second charge.
          "PayPal-Request-Id": `order:${sessionId}:capture`,
        },
        body: {},
      });
    },

    async getSessionStatus(sessionId: string): Promise<SessionStatus> {
      const c = credentials();
      const order = await api<{
        status: string;
        purchase_units?: {
          amount?: { currency_code?: string; value?: string };
          payments?: { captures?: { id: string; status: string }[] };
        }[];
      }>(c, `/v2/checkout/orders/${encodeURIComponent(sessionId)}`, {
        method: "GET",
      });

      const unit = order.purchase_units?.[0];
      const capture = unit?.payments?.captures?.[0];
      const currency = unit?.amount?.currency_code ?? "USD";

      // PayPal's COMPLETED means captured, i.e. money actually moved.
      // APPROVED means the buyer agreed but nothing has been charged — that
      // maps to "open / unpaid", never to paid.
      const status: SessionStatus["status"] =
        order.status === "COMPLETED"
          ? "complete"
          : order.status === "APPROVED" || order.status === "CREATED" ||
              order.status === "PAYER_ACTION_REQUIRED"
            ? "open"
            : order.status === "VOIDED"
              ? "expired"
              : "unknown";

      return {
        status,
        paymentStatus:
          capture?.status === "COMPLETED"
            ? "paid"
            : status === "open"
              ? "unpaid"
              : "unknown",
        amountTotalMinor: amountToMinor(unit?.amount?.value, currency),
        paymentIntentId: capture?.id ?? null,
      };
    },
  };
}
