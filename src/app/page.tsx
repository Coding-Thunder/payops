import type { Metadata } from "next";
import { redirect } from "next/navigation";

/**
 * `/` on a single-merchant deployment.
 *
 * This route used to render the platform vendor's product marketing site —
 * "Payment Operations Platform · Chargeback Evidence", a multi-gateway
 * feature tour, JSON-LD declaring the host to be a SoftwareApplication, and
 * a lead-capture form addressed to the vendor's team. All of that describes
 * the software, not the business the customer is paying.
 *
 * On this deployment the hostname belongs to the merchant, and the only
 * people who reach it are that merchant's customers (arriving from a payment
 * link) and its own operators. Neither should be shown a pitch for the
 * platform, so `/` now goes straight to the operator sign-in, which is
 * branded from APP_NAME.
 *
 * Nothing was deleted: every marketing component still lives under
 * `src/components/marketing/`, and restoring the landing page is a revert of
 * this one file.
 *
 * Customers are never sent here — no email, payment page or consent page
 * links to `/`. Their journey is entirely token-bound: /consent/<token>,
 * the gateway's hosted checkout, then /pay/success.
 */
export const metadata: Metadata = {
  // Nothing to index: this is a redirect to a private sign-in screen.
  robots: { index: false, follow: false },
};

export default function RootPage() {
  redirect("/login");
}
