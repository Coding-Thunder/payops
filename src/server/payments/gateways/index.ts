import "server-only";

import type { PaymentGateway, PaymentGatewayKey } from "../gateway";

import { stripeGateway } from "./stripe";

/**
 * Payment-gateway registry.
 *
 * Only Stripe ships today; Razorpay / Authorize.net / PayPal / manual
 * invoice are placeholders so the admin UI can show "coming soon"
 * affordances without the orchestration layer caring which is real.
 *
 * Adding a real gateway:
 *   1. Implement `PaymentGateway` in `./<vendor>.ts`
 *   2. Register it below
 *   3. The order lifecycle + composer + webhook route pick it up
 *      automatically via `getGateway(key)` / `listGateways()`
 */

interface PlaceholderInput {
  key: PaymentGatewayKey;
  label: string;
}

/** Read-only stub for not-yet-implemented gateways. Throws on any
 *  operation — the composer UI guards against selection, so the only
 *  way to hit these in practice is a programmatic mistake. */
function placeholder({ key, label }: PlaceholderInput): PaymentGateway {
  const notImplemented = (op: string) => {
    throw new Error(
      `${label} (${key}) is not implemented yet. Call site must guard on gateway.enabled.`,
    );
  };
  return {
    key,
    label,
    enabled: false,
    sandbox: false,
    async createSession() {
      notImplemented("createSession");
      throw new Error("unreachable");
    },
    async expireSession() {
      notImplemented("expireSession");
    },
    verifyWebhook() {
      notImplemented("verifyWebhook");
      throw new Error("unreachable");
    },
    async getSessionStatus() {
      notImplemented("getSessionStatus");
      throw new Error("unreachable");
    },
  };
}

const REGISTRY: Record<PaymentGatewayKey, PaymentGateway> = {
  STRIPE: stripeGateway,
  RAZORPAY: placeholder({ key: "RAZORPAY", label: "Razorpay" }),
  AUTHORIZE_NET: placeholder({ key: "AUTHORIZE_NET", label: "Authorize.net" }),
  PAYPAL: placeholder({ key: "PAYPAL", label: "PayPal" }),
  MANUAL: placeholder({ key: "MANUAL", label: "Manual invoice" }),
};

export function getGateway(key: PaymentGatewayKey): PaymentGateway {
  return REGISTRY[key];
}

export function listGateways(): PaymentGateway[] {
  // Deterministic ordering for admin UIs: Stripe first, then alphabetical.
  const all = Object.values(REGISTRY);
  return [
    ...all.filter((g) => g.key === "STRIPE"),
    ...all
      .filter((g) => g.key !== "STRIPE")
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

/** Single source of truth for "which gateway does the system default
 *  to for new orders". Stripe today; pivot here if that changes. */
export function getDefaultGateway(): PaymentGateway {
  return REGISTRY.STRIPE;
}
