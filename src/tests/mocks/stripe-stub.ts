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
}

export interface StripeStubOptions {
  successBaseUrl?: string;
  failOnNextCreate?: { code: string; message: string } | null;
}

export interface StripeStub {
  readonly sessionsCreated: RecordedSessionCreate[];
  readonly sessionsExpired: string[];

  /** Forces the next `checkout.sessions.create` to throw. */
  failNextCreate(err: { code: string; message: string }): void;

  /** Clears recorded calls. */
  reset(): void;

  /** Returns the underlying object as the Stripe-typed surface. */
  asStripe(): Stripe;
}

export function createStripeStub(opts: StripeStubOptions = {}): StripeStub {
  const sessionsCreated: RecordedSessionCreate[] = [];
  const sessionsExpired: string[] = [];
  let nextFailure = opts.failOnNextCreate ?? null;
  let sessionCounter = 0;

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
            amount_total:
              params.line_items?.[0]?.price_data?.unit_amount ?? null,
            currency:
              params.line_items?.[0]?.price_data?.currency?.toLowerCase() ??
              null,
            metadata: params.metadata ?? {},
            expires_at:
              params.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
            created: Math.floor(Date.now() / 1000),
          } as unknown as Stripe.Checkout.Session;

          sessionsCreated.push({ params, options, result: session });
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
    failNextCreate(err) {
      nextFailure = err;
    },
    reset() {
      sessionsCreated.length = 0;
      sessionsExpired.length = 0;
      nextFailure = null;
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
