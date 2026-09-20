import { ForbiddenError } from "@/lib/errors";

/**
 * ============================================================================
 *  PAID FEATURES ARE CURRENTLY DISABLED.
 * ============================================================================
 *
 * The features below are fully implemented and tested, but the client has
 * not paid for them yet, so they are switched off. Nothing was deleted: the
 * services, routes, components, tests and database fields are all in place.
 *
 *   - Orders XLSX export (export of selected orders)
 *   - Stripe → PayPal fallback / switching an order to another gateway
 *   - PayPal / Stripe → Manual fallback
 *   - Manual payment workflow (manual consent request + Record manual payment)
 *   - MCO / amount changes: Edit order page, re-pricing, and their UI
 *   - Held-payment reconciliation and payment-attempt history UI
 *
 * While this is `false` the product behaves as it did before that work:
 * their buttons, links and notices are not shown, their pages redirect, and
 * their API routes refuse with 403 — so they cannot be reached by bypassing
 * the UI. Everything that existed before (orders, Stripe/PayPal links,
 * regenerate, consent, emails, delete, flags, disputes…) is unaffected.
 *
 * The payment-safety checks added alongside them (stale / superseded session
 * protection, held payments, idempotency) stay on regardless: they are what
 * stops a customer being charged twice and are never switched off.
 *
 * TO ENABLE AFTER PAYMENT: change `false` to `true` below, then build and
 * deploy. That is the only change needed.
 */
export const PAID_FEATURES_ENABLED: boolean = false;

/**
 * Guard for the API routes of the paid features. Refuses with 403 while they
 * are disabled, before the route does any work.
 */
export function assertPaidFeaturesEnabled(): void {
  if (!PAID_FEATURES_ENABLED) {
    throw new ForbiddenError("This feature is not enabled.");
  }
}
