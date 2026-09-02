import "server-only";

import { DisputeOutcome, DisputeStatus } from "@/lib/constants/enums";
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

/**
 * The ONLY PayPal host this adapter talks to.
 *
 * There is deliberately no sandbox constant and no way to select one. This
 * deployment takes live payments, and every mechanism that could have flipped
 * the host — a PAYPAL_SANDBOX env var, an ORG_<SLUG>_PAYPAL_SANDBOX override,
 * and (earlier) the organization's Stripe-derived `payments.sandbox` flag —
 * has been removed rather than merely defaulted to false. A switch that exists
 * can be flipped by accident; one that does not exist cannot.
 *
 * Consequence to be aware of: this adapter can no longer be pointed at
 * api-m.sandbox.paypal.com at all. Restoring sandbox support means restoring
 * the constant and threading a flag back through PayPalCredentials.
 */
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
  // Keyed on clientId alone — there is only one host now, so there is no
  // environment dimension left to separate cache entries by.
  const key = c.clientId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) return cached.token;

  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await withTimeout((signal) =>
    fetchImpl(`${LIVE_BASE}/v1/oauth2/token`, {
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

/**
 * A non-2xx response from PayPal, carrying enough structure for a caller to
 * decide whether retrying could possibly help.
 *
 * The message string used to be the only signal, which meant the webhook
 * route could not tell "this order was already captured" (safe, terminal)
 * from "PayPal returned 503" (transient, must retry). Those two need
 * opposite HTTP responses: acknowledge the first so PayPal stops replaying,
 * fail the second so PayPal delivers it again.
 */
export class PayPalApiError extends Error {
  readonly status: number;
  /** PayPal's `details[].issue` codes, e.g. ORDER_ALREADY_CAPTURED. */
  readonly issues: readonly string[];
  /** PayPal's `name`, e.g. UNPROCESSABLE_ENTITY. */
  readonly errorName: string | null;
  readonly debugId: string | null;

  constructor(args: {
    method: string;
    path: string;
    status: number;
    issues: string[];
    errorName: string | null;
    debugId: string | null;
  }) {
    super(
      `PayPal ${args.method} ${args.path} failed (${args.status})` +
        (args.errorName ? `: ${args.errorName}` : "") +
        (args.issues.length ? ` [${args.issues.join(", ")}]` : ""),
    );
    this.name = "PayPalApiError";
    this.status = args.status;
    this.issues = args.issues;
    this.errorName = args.errorName;
    this.debugId = args.debugId;
  }
}

/** Parse PayPal's error envelope without letting a malformed body throw. */
function parsePayPalError(text: string): {
  issues: string[];
  errorName: string | null;
  debugId: string | null;
} {
  try {
    const j = JSON.parse(text) as {
      name?: string;
      debug_id?: string;
      details?: { issue?: string }[];
    };
    return {
      issues: (j.details ?? [])
        .map((d) => d.issue)
        .filter((i): i is string => typeof i === "string"),
      errorName: typeof j.name === "string" ? j.name : null,
      debugId: typeof j.debug_id === "string" ? j.debug_id : null,
    };
  } catch {
    return { issues: [], errorName: null, debugId: null };
  }
}

async function api<T>(
  c: PayPalCredentials,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const token = await accessToken(c);
  const res = await withTimeout((signal) =>
    fetchImpl(`${LIVE_BASE}${path}`, {
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
    // Deliberately does NOT put the response body in the message: PayPal
    // echoes request fields on some errors. The structured fields below carry
    // everything a caller needs to classify it.
    const { issues, errorName, debugId } = parsePayPalError(text);
    throw new PayPalApiError({
      method: init.method,
      path,
      status: res.status,
      issues,
      errorName,
      debugId,
    });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * PayPal refused this capture because the order is already captured.
 *
 * This is the ONLY capture failure that is safe to acknowledge: it means a
 * replayed CHECKOUT.ORDER.APPROVED reached us after the money already moved,
 * and PAYMENT.CAPTURE.COMPLETED has done (or will do) the real work. Every
 * other failure — 5xx, timeout, auth, rate limit — must be surfaced so the
 * delivery is retried, because the alternative is an approved order that is
 * never charged and never looked at again.
 */
export function isAlreadyCapturedError(err: unknown): boolean {
  if (!(err instanceof PayPalApiError)) return false;
  if (err.status !== 422) return false;
  return err.issues.includes("ORDER_ALREADY_CAPTURED");
}

/**
 * PayPal refused the capture for a reason that retrying cannot fix — the
 * buyer's funding instrument was declined, or the order is not in a
 * capturable state.
 *
 * Distinct from `isAlreadyCapturedError`: nothing was captured and nothing
 * will be. Retrying for three days would only bury the webhook in failures,
 * so the route acknowledges these too — but records them as a FAILURE rather
 * than pretending the capture succeeded. PayPal separately delivers
 * PAYMENT.CAPTURE.DENIED for the declined case, which is what actually moves
 * the order to failed.
 */
export function isTerminalCaptureError(err: unknown): boolean {
  if (!(err instanceof PayPalApiError)) return false;
  if (err.status !== 422) return false;
  return err.issues.some((i) =>
    [
      "INSTRUMENT_DECLINED",
      "PAYER_ACTION_REQUIRED",
      "ORDER_NOT_APPROVED",
      "ORDER_ALREADY_AUTHORIZED",
      "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
      "PAYEE_ACCOUNT_RESTRICTED",
    ].includes(i),
  );
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

/**
 * PayPal dispute status -> our DisputeStatus enum.
 *
 * PayPal's vocabulary is smaller than Stripe's and has no "warning" tier, so
 * several of our values are simply unreachable from PayPal. The important
 * property is that a RESOLVED dispute never lands in UNDER_REVIEW: the
 * outcome mapper below decides WON/LOST from `dispute_outcome.outcome_code`,
 * and the status follows it.
 */
function mapPayPalDisputeStatus(
  raw: string | undefined,
  outcomeCode: string | undefined,
): string {
  switch (raw) {
    case "WAITING_FOR_SELLER_RESPONSE":
      return DisputeStatus.NEEDS_RESPONSE;
    case "WAITING_FOR_BUYER_RESPONSE":
    case "UNDER_REVIEW":
    case "OPEN":
      return DisputeStatus.UNDER_REVIEW;
    case "RESOLVED": {
      const o = mapPayPalDisputeOutcome(outcomeCode);
      return o === DisputeOutcome.WON
        ? DisputeStatus.WON
        : o === DisputeOutcome.CHARGE_REFUNDED
          ? DisputeStatus.CHARGE_REFUNDED
          : DisputeStatus.LOST;
    }
    default:
      logger.warn("paypal.dispute.unknown_status", { raw });
      return DisputeStatus.UNDER_REVIEW;
  }
}

/** PayPal `dispute_outcome.outcome_code` -> our DisputeOutcome, or null
 *  while the dispute is still open. */
function mapPayPalDisputeOutcome(raw: string | undefined): string | null {
  switch (raw) {
    case "RESOLVED_SELLER_FAVOUR":
    case "RESOLVED_SELLER_FAVOR":
      return DisputeOutcome.WON;
    case "RESOLVED_BUYER_FAVOUR":
    case "RESOLVED_BUYER_FAVOR":
      return DisputeOutcome.LOST;
    case "CANCELED_BY_BUYER":
      return DisputeOutcome.WON;
    default:
      return null;
  }
}

/** The capture id a refund or dispute refers to — this is what the order
 *  stores as `payment.paymentIntentId`, so it is how the handler finds the
 *  order. Without it a PayPal refund/dispute cannot be attributed. */
function captureIdFromLinks(resource: Record<string, unknown>): string | null {
  const links = resource.links as { rel?: string; href?: string }[] | undefined;
  const up = links?.find((l) => l.rel === "up")?.href;
  const m = up?.match(/\/payments\/captures\/([^/?#]+)/);
  return m?.[1] ?? null;
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
      // Structurally false. `sandbox` stays on the PaymentGateway contract
      // because Stripe derives it from its key prefix and admin UIs render it,
      // but for PayPal there is no longer anything to derive it from: the
      // adapter has exactly one host. Reporting it as a constant is honest —
      // it can never be true.
      return false;
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

      const eventType = mapPayPalEventType(parsed.event_type);
      const isRefund = eventType === "refund.created";
      const isDispute = eventType.startsWith("dispute.");

      /**
       * Which id the order is found by.
       *
       * `payment.paymentIntentId` on the order is the CAPTURE id, stamped
       * from PAYMENT.CAPTURE.COMPLETED where `resource.id` is the capture.
       * On a refund event `resource.id` is the REFUND id, and on a dispute
       * event it is the dispute id — using either would look up an order
       * that does not exist. Both carry the capture id elsewhere, so resolve
       * it explicitly.
       */
      const disputedTx = (
        resource.disputed_transactions as
          | { seller_transaction_id?: string; custom?: string }[]
          | undefined
      )?.[0];
      const paymentIntentId = isRefund
        ? (captureIdFromLinks(resource) ??
          (resource.id as string | undefined) ??
          null)
        : isDispute
          ? (disputedTx?.seller_transaction_id ?? null)
          : ((resource.id as string | undefined) ?? null);

      const disputeAmount = resource.dispute_amount as
        | { currency_code?: string; value?: string }
        | undefined;
      const outcomeCode = (
        resource.dispute_outcome as { outcome_code?: string } | undefined
      )?.outcome_code;
      const breakdown = resource.seller_payable_breakdown as
        | { total_refunded_amount?: { currency_code?: string; value?: string } }
        | undefined;
      const dueBy = resource.seller_response_due_date as string | undefined;

      return {
        eventId: parsed.id,
        type: eventType,
        // The PayPal ORDER id is our session id. On capture events it lives
        // under supplementary_data; on order events it is the resource id.
        sessionId:
          supplementary?.related_ids?.order_id ??
          (parsed.event_type.startsWith("CHECKOUT.ORDER.")
            ? ((resource.id as string | undefined) ?? null)
            : null),
        orderId,
        paymentIntentId,
        amountTotalMinor: amountToMinor(amount?.value, currency),
        occurredAtMs: parsed.create_time
          ? Date.parse(parsed.create_time)
          : Date.now(),
        // Populated so the shared handlers can act. Without these the
        // handlers return `missing_dispute_payload` / `missing_refund_payload`
        // and every PayPal chargeback and refund is acknowledged and dropped.
        dispute: isDispute
          ? {
              gatewayDisputeId:
                (resource.dispute_id as string | undefined) ??
                (resource.id as string | undefined) ??
                parsed.id,
              chargeId: paymentIntentId,
              status: mapPayPalDisputeStatus(
                resource.status as string | undefined,
                outcomeCode,
              ),
              reason: (resource.reason as string | undefined) ?? null,
              amountMinor: amountToMinor(
                disputeAmount?.value,
                disputeAmount?.currency_code ?? currency,
              ),
              currency: disputeAmount?.currency_code ?? currency,
              evidenceDueByMs: dueBy ? Date.parse(dueBy) : null,
              outcome: mapPayPalDisputeOutcome(outcomeCode),
            }
          : null,
        refund: isRefund
          ? {
              gatewayRefundId: (resource.id as string | undefined) ?? parsed.id,
              chargeId: paymentIntentId,
              amountMinor: amountToMinor(amount?.value, currency),
              amountRefundedTotalMinor: amountToMinor(
                breakdown?.total_refunded_amount?.value ?? amount?.value,
                breakdown?.total_refunded_amount?.currency_code ?? currency,
              ),
              currency,
              reason: (resource.note_to_payer as string | undefined) ?? null,
            }
          : null,
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
