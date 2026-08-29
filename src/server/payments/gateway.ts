import "server-only";

/**
 * Gateway-agnostic payment orchestration layer.
 *
 * Order / email / webhook code talks to this interface — no caller
 * imports Stripe (or any other gateway SDK) directly. Adding a new
 * gateway means writing one implementation of `PaymentGateway` and
 * registering it in `./gateways/index.ts`; nothing in the order
 * lifecycle, email composer, or webhook handler needs to change.
 *
 * Design notes:
 *   - Amounts are passed in MAJOR units (e.g. dollars) on the way in;
 *     gateway implementations convert to minor units as their SDK
 *     requires. Amounts coming OUT of the gateway (webhook payloads,
 *     session-status retrievals) are returned in MINOR units, which
 *     callers convert back as needed. This mirrors how Stripe reports
 *     `amount_total` and keeps integer math honest.
 *   - `verifyWebhook` returns a normalised event shape. Gateway-specific
 *     event types (e.g. Stripe's `checkout.session.async_payment_failed`)
 *     are mapped to a small enum the order lifecycle understands.
 *   - `getSessionStatus` is the lookup the reconcile endpoint uses when
 *     a webhook never arrives.
 */

export type PaymentGatewayKey =
  | "STRIPE"
  | "RAZORPAY"
  | "AUTHORIZE_NET"
  | "PAYPAL"
  | "MANUAL";

export interface CreatePaymentSessionInput {
  orderId: string;
  orderNumber: string;
  /** Major units (e.g. 19.50). The gateway implementation converts to
   *  minor as required by its SDK. */
  amount: number;
  /** ISO-4217 code, uppercase. Implementations lowercase as needed. */
  currency: string;
  customer: { name: string; email: string; phone: string };
  /** Short label rendered on the gateway-hosted checkout page. */
  productName: string;
  description: string;
  imageUrls?: string[];
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  /** Free-form string-to-string map the gateway will echo back on its
   *  webhook. Used to recover the order id when client_reference_id
   *  isn't enough. */
  metadata: Record<string, string>;
  /**
   * Whether the gateway should TAKE the money at checkout or merely place
   * a hold to be captured later.
   *
   * OPTIONAL and undefined by default. When it is undefined an
   * implementation must emit exactly the request it emitted before this
   * field existed — that is what keeps the two incumbent brands'
   * outgoing Stripe payloads byte-identical.
   */
  captureMethod?: "automatic" | "manual";
}

export interface CreatedPaymentSession {
  /** Gateway-assigned session id. Stored on the order so webhook events
   *  + reconcile lookups can find the order back. */
  sessionId: string;
  /** Hosted-checkout URL the customer opens. */
  url: string;
  /** Stripe-style payment-intent id (or equivalent on other gateways).
   *  Some gateways don't surface this separately; that's fine. */
  paymentIntentId: string | null;
  expiresAt: Date;
}

/**
 * Normalised webhook event types. Each gateway maps its own provider
 * events to these. Unknown / unhandled events surface as "unhandled"
 * so the webhook route can ack them without acting.
 */
export type PaymentEventType =
  | "checkout.completed"
  | "checkout.expired"
  | "checkout.failed"
  | "payment.failed"
  /** Funds held, NOT taken. Manual capture only — an automatic-capture
   *  gateway never emits this. */
  | "payment.authorized"
  /** A previously authorized hold has been converted into a charge. */
  | "payment.captured"
  /** An authorization was released without ever being captured. */
  | "payment.cancelled"
  | "dispute.created"
  | "dispute.updated"
  | "dispute.closed"
  | "dispute.funds_withdrawn"
  | "refund.created"
  | "unhandled";

/**
 * Dispute-specific payload normalised across gateways. Optional on the
 * verified event — only populated for `dispute.*` event types. Stripe's
 * `Dispute.status` string is mapped to our DisputeStatus enum at the
 * gateway layer so downstream code never sees provider-specific values.
 */
export interface VerifiedDisputePayload {
  /** Gateway-side dispute id (`du_...` on Stripe). */
  gatewayDisputeId: string;
  /** Gateway-side charge id this dispute targets. */
  chargeId: string | null;
  /** Normalised dispute status (DisputeStatus enum value). */
  status: string;
  /** Stripe's `reason` string — kept verbatim because the enum is huge
   *  and rarely exercised. UI surfaces it as freeform text. */
  reason: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** Epoch ms by which evidence must be submitted. Null on closed
   *  disputes or warnings. */
  evidenceDueByMs: number | null;
  /** Set on `dispute.closed` to indicate the final outcome
   *  (DisputeOutcome enum value). Null while still open. */
  outcome: string | null;
}

/**
 * Refund-specific payload normalised across gateways. Populated for
 * `refund.created` events. We model refunds as additive — multiple
 * partial refunds may stack on a single order over time, so the handler
 * needs amountRefundedMinor for the SPECIFIC refund event, plus
 * amountRefundedTotalMinor for the cumulative state on the charge.
 */
export interface VerifiedRefundPayload {
  /** Gateway-side refund id (`re_...` on Stripe). */
  gatewayRefundId: string;
  chargeId: string | null;
  /** Amount on this refund event. */
  amountMinor: number | null;
  /** Cumulative refunded amount across all refund records on the charge
   *  (after this event). Lets the handler distinguish partial from full. */
  amountRefundedTotalMinor: number | null;
  currency: string | null;
  reason: string | null;
}

/**
 * Authorization-specific payload, normalised across gateways. Populated
 * only for the three manual-capture event types.
 */
export interface VerifiedAuthorizationPayload {
  paymentIntentId: string | null;
  /** Gateway's own capture-method string, e.g. Stripe's "manual". */
  captureMethod: string | null;
  /** Gateway's own intent status, e.g. Stripe's "requires_capture". */
  paymentIntentStatus: string | null;
  /** Minor units still available to capture. */
  amountCapturableMinor: number | null;
  /** Minor units actually collected so far. */
  amountReceivedMinor: number | null;
  /** Why the authorization was released, when the gateway says. Stripe's
   *  "automatic" means IT released the hold, not an operator. */
  cancellationReason: string | null;
}

export interface VerifiedPaymentEvent {
  /** Gateway's event id — used for the order's
   *  `processedWebhookEventIds` idempotency list. */
  eventId: string;
  type: PaymentEventType;
  /** Session id the event refers to, if known. */
  sessionId: string | null;
  /** Order id round-tripped via the gateway's metadata (Stripe's
   *  `client_reference_id` / `metadata.orderId`). Lets the webhook
   *  processor find the order even if the session id was rotated. */
  orderId: string | null;
  paymentIntentId: string | null;
  /** Minor units. `null` when the gateway doesn't include it on this
   *  event type. */
  amountTotalMinor: number | null;
  occurredAtMs: number;
  reason?: string | null;
  /** Populated when `type === "dispute.*"`. */
  dispute?: VerifiedDisputePayload | null;
  /** Populated when `type === "refund.created"`. */
  refund?: VerifiedRefundPayload | null;
  /** Populated for `payment.authorized` / `payment.captured` /
   *  `payment.cancelled`. Null on every other event type, and therefore on
   *  every event either incumbent brand produces. */
  authorization?: VerifiedAuthorizationPayload | null;
  /** Underlying provider payload — kept around for audit. */
  raw: unknown;
}

export interface SessionStatus {
  /** Lifecycle of the checkout session on the gateway side. */
  status: "open" | "complete" | "expired" | "unknown";
  /** Payment state when the gateway distinguishes "session done" from
   *  "money actually collected" (Stripe does). */
  paymentStatus: "paid" | "unpaid" | "no_payment_required" | "unknown";
  amountTotalMinor: number | null;
  paymentIntentId: string | null;
  /** Gateway's capture method for this session, when it exposes one.
   *  Optional so no existing consumer changes. */
  captureMethod?: "automatic" | "automatic_async" | "manual" | null;
  /** Minor units still capturable. Null unless the gateway reports it. */
  amountCapturableMinor?: number | null;
  /** Gateway's own payment-intent status string. */
  paymentIntentStatus?: string | null;
}

export interface PaymentGateway {
  /** Stable identifier used in DB + API contracts. */
  readonly key: PaymentGatewayKey;
  /** Human label for admin UIs. */
  readonly label: string;
  /** True iff the implementation has the credentials it needs. Disabled
   *  gateways still appear in the admin list (with a "configure"
   *  affordance) but can't be selected for new orders. */
  readonly enabled: boolean;
  /** Best-effort indicator: true in test/sandbox mode, false in live.
   *  Surfaced in the admin UI so an agent never confuses the two. */
  readonly sandbox: boolean;

  createSession(input: CreatePaymentSessionInput): Promise<CreatedPaymentSession>;
  expireSession(sessionId: string): Promise<void>;
  /**
   * Verifies authenticity AND parses the payload. Throws on a bad signature
   * or malformed body — the webhook route surfaces 400 in that case.
   *
   * Takes the whole header set rather than one signature string, and may
   * return a promise, because gateways authenticate webhooks in
   * fundamentally different ways:
   *
   *   Stripe   computes an HMAC locally over `stripe-signature` — one
   *            header, synchronous, no network.
   *   PayPal   has no signing secret at all. Authenticity is established by
   *            calling PayPal back at
   *            /v1/notifications/verify-webhook-signature with FIVE
   *            transmission headers plus the webhook id — an async round
   *            trip that can fail on the network.
   *
   * A single-header synchronous signature could not express the second, so
   * the contract is the union of both. Synchronous implementations simply
   * return a value and callers await it.
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
  ): VerifiedPaymentEvent | Promise<VerifiedPaymentEvent>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  /**
   * Whether this gateway can authorize-now / capture-later.
   *
   * OPTIONAL, and absent on every implementation that cannot — exactly the
   * way PayPal's `captureOrder` is kept off the shared contract (see
   * `supportsCapture` in ./gateways/paypal.ts). Putting `capturePayment`
   * on the required surface would force a method onto PayPal and the four
   * unimplemented registry placeholders that none of them can honour.
   */
  readonly supportsManualCapture?: boolean;
  capturePayment?(
    paymentIntentId: string,
    opts?: { amountMinor?: number | null; idempotencyKey?: string },
  ): Promise<CaptureResult>;
  cancelPayment?(
    paymentIntentId: string,
    opts?: {
      reason?: "abandoned" | "duplicate" | "fraudulent" | "requested_by_customer";
      idempotencyKey?: string;
    },
  ): Promise<CancelResult>;
}

export interface CaptureResult {
  paymentIntentId: string;
  /** Gateway's own terminal status, e.g. Stripe's "succeeded". */
  status: string;
  amountReceivedMinor: number | null;
}

export interface CancelResult {
  paymentIntentId: string;
  /** Gateway's own status, e.g. Stripe's "canceled". */
  status: string;
}

/** A gateway that genuinely implements authorize-then-capture. */
export interface ManualCaptureGateway extends PaymentGateway {
  capturePayment(
    paymentIntentId: string,
    opts?: { amountMinor?: number | null; idempotencyKey?: string },
  ): Promise<CaptureResult>;
  cancelPayment(
    paymentIntentId: string,
    opts?: {
      reason?: "abandoned" | "duplicate" | "fraudulent" | "requested_by_customer";
      idempotencyKey?: string;
    },
  ): Promise<CancelResult>;
}

/**
 * Type guard for the optional manual-capture capability. Mirrors
 * `supportsCapture` in ./gateways/paypal.ts so the codebase gains no new
 * pattern for "this gateway can do more than the base contract".
 */
export function supportsManualCapture(
  gateway: PaymentGateway,
): gateway is ManualCaptureGateway {
  const g = gateway as Partial<ManualCaptureGateway>;
  return (
    g.supportsManualCapture === true &&
    typeof g.capturePayment === "function" &&
    typeof g.cancelPayment === "function"
  );
}

/**
 * Case-insensitive header lookup, satisfied by the Web `Headers` object a
 * Route Handler already has. Keeps gateways from depending on Next types.
 */
export interface WebhookHeaders {
  get(name: string): string | null;
}
