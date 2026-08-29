import { redirect } from "next/navigation";

import { getCurrentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Root entry. No longer the marketing landing page — this deployment is an
 * internal operations console, so `/` hands straight to the application.
 *
 * Deliberately a PAGE-LEVEL redirect and not a proxy/middleware rule. The
 * middleware is what production Stripe and PayPal webhook deliveries pass
 * through (or, for `/api/webhooks/stripe`, are explicitly excluded from by
 * the matcher), and adding routing logic there to solve a marketing-page
 * problem is how a webhook silently starts receiving a 307 to /login and
 * payments stop confirming. Nothing about routing, authentication or raw
 * body handling changes for any API route.
 *
 * The marketing components under `src/components/marketing/` are left in
 * place: they are still used by the quotation form and the SEO routes, and
 * removing them would be unrelated cleanup.
 *
 * Follows the existing auth flow rather than inventing one — signed in goes
 * to the dashboard, signed out goes to login, which is exactly what the
 * proxy already does for every other authenticated path.
 */
export default async function RootPage() {
  const user = await getCurrentUser();
  redirect(user ? "/app/dashboard" : "/login");
}
