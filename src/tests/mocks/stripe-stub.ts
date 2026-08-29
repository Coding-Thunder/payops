/**
 * In-process Stripe stub used by integration + smoke tests.
 *
 * Why an in-process stub instead of intercepting network calls?
 *   - Deterministic: session ids, signatures, and timing are stable.
 *   - Offline: smoke tests run without Stripe credentials or network.
 *   - Composable: tests can pre-stage responses, simulate failures, and
 *     introspect calls without touching HTTP plumbing.
 *
 * Behaviour:
 *   - checkout.sessions.create  → returns a stub session with a synthetic
 *     id (cs_test_…) and a `url` that points at our own /pay/success
 *     endpoint so smoke tests can finish the flow with an HTTP GET.
 *   - checkout.sessions.expire  → records the call; returns the recorded
 *     session marked expired.
 *   - paymentIntents.capture / .cancel / .retrieve → operate on the
 *     registry of intents minted alongside each checkout session, so an
 *     authorize-then-capture flow can be driven end-to-end offline.
 *   - webhooks.constructEvent   → verifies the HMAC signature using the
 *     same scheme Stripe uses (t=<unix>,v1=<sig>) against the supplied
 *     secret, then parses the JSON body.
 *
 * The stub is intentionally minimal — it implements only what PayOps
 * actually calls. New entry points should fail loudly so a missing
 * implementation is obvious.
 */

import crypto from "node:crypto";

import type Stripe from "stripe";

export interface RecordedSessionCreate {
  params: Stripe.Checkout.SessionCreateParams;
  options?: Stripe.RequestOptions;
  result: Stripe.Checkout.Session;
  /**
   * Whether the caller asked for `capture_method: "manual"`. Recorded
   * rather than re-derived so a test can assert on the request that was
   * made, not on the stub's interpretation of it.
   */
  manualCapture: boolean;
}

export interface RecordedCapture {
  id: string;
  params?: Stripe.PaymentIntentCaptureParams;
  options?: Stripe.RequestOptions;
}

export interface RecordedCancel {
  id: string;
  params?: Stripe.PaymentIntentCancelParams;
  options?: Stripe.RequestOptions;
}

export interface StripeStubOptions {
  successBaseUrl?: string;
  failOnNextCreate?: { code: string; message: string } | null;
}

export interface StripeStub {
  readonly sessionsCreated: RecordedSessionCreate[];
  readonly sessionsExpired: string[];
  /** Every `paymentIntents.capture` call, in order — id, params and
   *  request options, so tests can assert on `amount_to_capture` and on
   *  the idempotency key that guards a double-click. */
  readonly capturesRequested: RecordedCapture[];
  /** Every `paymentIntents.cancel` call, in order. */
  readonly cancelsRequested: RecordedCancel[];

  /** Forces the next `checkout.sessions.create` to throw. */
  failNextCreate(err: { code: string; message: string }): void;

  /** Forces the next `paymentIntents.capture` to throw. Mirrors
   *  {@link StripeStub.failNextCreate}. */
  failNextCapture(err: { code: string; message: string }): void;

  /** Clears recorded calls. */
  reset(): void;

  /** Returns the underlying object as the Stripe-typed surface. */
  asStripe(): Stripe;
}

export function createStripeStub(opts: StripeStubOptions = {}): StripeStub {
  const sessionsCreated: RecordedSessionCreate[] = [];
  const sessionsExpired: string[] = [];
  const capturesRequested: RecordedCapture[] = [];
  const cancelsRequested: RecordedCancel[] = [];
  /**
   * The PaymentIntents this stub knows about, keyed by id. One is minted
   * alongside every checkout session, which is what the real Stripe does —
   * so a manual-capture flow can go create → authorize → capture/cancel
   * without any pre-staging.
   */
  const intents = new Map<string, Stripe.PaymentIntent>();
  let nextFailure = opts.failOnNextCreate ?? null;
  let nextCaptureFailure: { code: string; message: string } | null = null;
  let sessionCounter = 0;

  /**
   * Look up an intent, minting a plausible manual-capture one if the id is
   * unknown. Tests routinely capture an order whose intent id came from a
   * factory rather than from `checkout.sessions.create`; failing there
   * would be pedantry, not signal. `paymentIntents.retrieve` still throws
   * on an unknown id, so a genuine typo surfaces.
   */
  function ensureIntent(id: string): Stripe.PaymentIntent {
    const found = intents.get(id);
    if (found) return found;
    const created = {
      id,
      object: "payment_intent",
      status: "requires_capture",
      capture_method: "manual",
      amount: 0,
      amount_capturable: 0,
      amount_received: 0,
      currency: null,
      cancellation_reason: null,
      metadata: {},
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.PaymentIntent;
    intents.set(id, created);
    return created;
  }

  const successBaseUrl = opts.successBaseUrl ?? "http://127.0.0.1:3100";

  const stripeLike = {
    checkout: {
      sessions: {
        create: async (
          params: Stripe.Checkout.SessionCreateParams,
          options?: Stripe.RequestOptions,
        ): Promise<Stripe.Checkout.Session> => {
          if (nextFailure) {
            const err = new Error(nextFailure.message);
            (err as Error & { code?: string }).code = nextFailure.code;
            nextFailure = null;
            throw err;
          }
          sessionCounter += 1;
          const id = `cs_test_stub_${Date.now()}_${sessionCounter}`;
          const paymentIntentId = `pi_test_stub_${Date.now()}_${sessionCounter}`;
          /**
           * Recorded so a test can assert what was REQUESTED. It must not
           * change the freshly created session's `payment_status` — see
           * below.
           */
          const manualCapture =
            params.payment_intent_data?.capture_method === "manual";
          const amountTotal =
            params.line_items?.[0]?.price_data?.unit_amount ?? null;
          const orderId =
            params.client_reference_id ??
            (typeof params.metadata?.orderId === "string"
              ? params.metadata.orderId
              : "unknown");
          const session = {
            id,
            object: "checkout.session",
            mode: params.mode ?? "payment",
            status: "open",
            url: `${successBaseUrl}/pay/checkout/${id}?order=${encodeURIComponent(
              orderId,
            )}`,
            client_reference_id: params.client_reference_id ?? null,
            customer_email: params.customer_email ?? null,
            payment_intent: paymentIntentId,
            /**
             * DELIBERATELY ABSENT on a freshly created session, in BOTH
             * capture modes — which is how this stub has always behaved,
             * and what `getSessionStatus` maps to `paymentStatus:
             * "unknown"`. reconcile.test.ts asserts on exactly that.
             *
             * The paid-vs-authorized distinction only exists once a
             * session COMPLETES, and every test that needs it sets the
             * field explicitly on the recorded session (the established
             * pattern in reconcile.test.ts) or builds a webhook event with
             * `buildCheckoutCompleted({ paymentStatus })`.
             *
             * Two earlier attempts set it at creation — "paid" for
             * automatic capture, then "unpaid" for both. Each changed what
             * `getSessionStatus` reports for a brand-new session and broke
             * reconcile for the two incumbent brands. Do not reintroduce
             * either.
             */
            amount_total: amountTotal,
            currency:
              params.line_items?.[0]?.price_data?.currency?.toLowerCase() ??
              null,
            metadata: params.metadata ?? {},
            expires_at:
              params.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
            created: Math.floor(Date.now() / 1000),
          } as unknown as Stripe.Checkout.Session;

          // The intent Stripe would have created behind the session. A
          // manual-capture intent sits in `requires_capture` holding the
          // funds; an automatic one has already succeeded.
          intents.set(paymentIntentId, {
            id: paymentIntentId,
            object: "payment_intent",
            status: manualCapture ? "requires_capture" : "succeeded",
            capture_method: manualCapture ? "manual" : "automatic",
            amount: amountTotal ?? 0,
            amount_capturable: manualCapture ? (amountTotal ?? 0) : 0,
            amount_received: manualCapture ? 0 : (amountTotal ?? 0),
            currency:
              params.line_items?.[0]?.price_data?.currency?.toLowerCase() ??
              null,
            cancellation_reason: null,
            metadata: params.payment_intent_data?.metadata ??
              params.metadata ?? {},
            created: Math.floor(Date.now() / 1000),
          } as unknown as Stripe.PaymentIntent);

          sessionsCreated.push({ params, options, result: session, manualCapture });
          return session;
        },
        expire: async (sessionId: string) => {
          sessionsExpired.push(sessionId);
          return { id: sessionId, status: "expired" } as Stripe.Checkout.Session;
        },
        retrieve: async (sessionId: string) => {
          const found = sessionsCreated.find((s) => s.result.id === sessionId);
          if (!found) throw new Error(`No stubbed session ${sessionId}`);
          return found.result;
        },
      },
    },
    paymentIntents: {
      /**
       * Turn an authorized hold into a charge: status "succeeded" with
       * `amount_received` set. A partial `amount_to_capture` is honoured —
       * that is the figure the adapter sends and the one tests assert on.
       */
      capture: async (
        id: string,
        params?: Stripe.PaymentIntentCaptureParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.PaymentIntent> => {
        // Recorded BEFORE the staged failure fires, so a test can assert on
        // the idempotency key of an attempt that Stripe rejected.
        capturesRequested.push({ id, params, options });
        if (nextCaptureFailure) {
          const err = new Error(nextCaptureFailure.message);
          (err as Error & { code?: string }).code = nextCaptureFailure.code;
          nextCaptureFailure = null;
          throw err;
        }
        const intent = ensureIntent(id);
        const captured =
          typeof params?.amount_to_capture === "number"
            ? params.amount_to_capture
            : (intent.amount_capturable || intent.amount || 0);
        const next = {
          ...intent,
          status: "succeeded",
          amount_capturable: 0,
          amount_received: captured,
        } as unknown as Stripe.PaymentIntent;
        intents.set(id, next);
        return next;
      },
      /** Release the hold without charging: status "canceled". */
      cancel: async (
        id: string,
        params?: Stripe.PaymentIntentCancelParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.PaymentIntent> => {
        cancelsRequested.push({ id, params, options });
        const intent = ensureIntent(id);
        const next = {
          ...intent,
          status: "canceled",
          amount_capturable: 0,
          cancellation_reason: params?.cancellation_reason ?? null,
        } as unknown as Stripe.PaymentIntent;
        intents.set(id, next);
        return next;
      },
      retrieve: async (id: string): Promise<Stripe.PaymentIntent> => {
        const found = intents.get(id);
        if (!found) throw new Error(`No stubbed payment intent ${id}`);
        return found;
      },
    },
    webhooks: {
      constructEvent: (
        rawBody: string | Buffer,
        signatureHeader: string,
        secret: string,
        tolerance = 300,
      ): Stripe.Event => {
        const body =
          typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
        const sig = parseStripeSignature(signatureHeader);
        if (!sig) {
          throw new Error("Unable to extract timestamp and signatures from header");
        }
        const age = Math.abs(Math.floor(Date.now() / 1000) - sig.timestamp);
        if (age > tolerance) {
          throw new Error(
            `Timestamp outside the tolerance zone (${age} > ${tolerance})`,
          );
        }
        const expected = crypto
          .createHmac("sha256", secret)
          .update(`${sig.timestamp}.${body}`)
          .digest("hex");
        const match = sig.v1Signatures.some((candidate) =>
          timingSafeEqualHex(candidate, expected),
        );
        if (!match) {
          throw new Error("No signatures found matching the expected signature for payload");
        }
        return JSON.parse(body) as Stripe.Event;
      },
      /**
       * Test-only helper. Produces the same `t=…,v1=…` header that Stripe
       * sends, so tests can hit our webhook route through HTTP and have
       * the real `constructEvent` validate the payload.
       */
      generateTestHeaderString: ({
        payload,
        secret,
        timestamp,
      }: {
        payload: string;
        secret: string;
        timestamp?: number;
      }) => {
        const t = timestamp ?? Math.floor(Date.now() / 1000);
        const signature = crypto
          .createHmac("sha256", secret)
          .update(`${t}.${payload}`)
          .digest("hex");
        return `t=${t},v1=${signature}`;
      },
    },
  };

  return {
    sessionsCreated,
    sessionsExpired,
    capturesRequested,
    cancelsRequested,
    failNextCreate(err) {
      nextFailure = err;
    },
    failNextCapture(err) {
      nextCaptureFailure = err;
    },
    reset() {
      sessionsCreated.length = 0;
      sessionsExpired.length = 0;
      capturesRequested.length = 0;
      cancelsRequested.length = 0;
      intents.clear();
      nextFailure = null;
      nextCaptureFailure = null;
      sessionCounter = 0;
    },
    asStripe() {
      return stripeLike as unknown as Stripe;
    },
  };
}

interface ParsedSignature {
  timestamp: number;
  v1Signatures: string[];
}

function parseStripeSignature(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  if (!timestamp || Number.isNaN(timestamp) || v1.length === 0) return null;
  return { timestamp, v1Signatures: v1 };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
