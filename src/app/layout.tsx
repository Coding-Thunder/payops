import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppProviders } from "@/components/providers/app-providers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

/**
 * Root metadata.
 *
 * Strategy: full technical-SEO surface area at the root so every
 * route inherits sensible defaults — title template, canonical via
 * `metadataBase`, OG/Twitter cards, theme color, viewport. Per-page
 * `metadata` exports override the title + description.
 *
 * Marketing intent: rank for the long-tail vocabulary an enterprise
 * payments lead actually searches for ("chargeback evidence platform",
 * "dispute readiness", "multi-gateway orchestration", "payment
 * operations audit trail"). Keywords here are advisory only — Google
 * doesn't use the meta tag — but they shape the OG/Twitter snippets
 * and document the brand-positioning vocabulary in code.
 */

/**
 * Fallbacks are the merchant's own brand and host, not the platform's.
 *
 * These two variables are the single point where a customer-visible name
 * enters the document head, and NEXT_PUBLIC_* values are inlined at BUILD
 * time — so a deployment that forgets one on the build environment ships a
 * silently wrong title rather than failing. Defaulting to the platform's
 * name made that failure mode "every customer sees PayOps"; defaulting to
 * the merchant makes it a no-op.
 */
const SITE_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Rental Travels";
const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://rentaltravels.rentalconfirmation.com"
).replace(/\/$/, "");
// This deployment serves ONE merchant, and these strings reach that
// merchant's customers: they are the <meta description> on the hosted
// consent page and on both /pay return pages, and they are what a customer
// sees when a payment link is pasted into WhatsApp or iMessage. The copy
// that used to live here pitched the payment-operations product itself,
// which is the vendor's positioning, not the merchant's business.
const HEADLINE = "Secure Booking Payments & Confirmations";
const DESCRIPTION = `Pay for your booking with ${SITE_NAME} through a secure, single-use payment link. Card details are handled entirely by a PCI-DSS Level 1 certified payment provider, and a written confirmation and receipt are emailed the moment payment clears.`;
const SHORT_DESCRIPTION = `Secure booking payments and written confirmations from ${SITE_NAME}.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${HEADLINE}`,
    template: `%s • ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  generator: "Next.js",
  referrer: "strict-origin-when-cross-origin",
  category: "fintech",
  classification: "business",
  // Scoped to what this deployment actually is — a merchant's booking
  // payment surface. The previous list was the vendor product's SEO
  // vocabulary ("chargeback evidence", "stripe alternative", "payment
  // orchestration"); indexing this host against those terms describes a
  // business the customer is not buying from.
  keywords: [
    "car rental booking payment",
    "secure booking payment link",
    "rental reservation confirmation",
    "booking confirmation email",
    "prepaid rental deposit",
    "pay for car rental online",
    "secure card payment",
    "booking receipt",
  ],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  manifest: "/manifest.webmanifest",
  // Default canonical points at the landing; per-page overrides set
  // their own `alternates.canonical` when needed.
  alternates: {
    canonical: SITE_URL,
    languages: { "en-US": SITE_URL },
  },
  // NO `images` here, deliberately. `src/app/opengraph-image.tsx` generates
  // the card at /opengraph-image and Next injects it, so this file naming a
  // second image only creates ambiguity about which one a crawler picks.
  //
  // What used to be named here was /marketing/evidence-chain.webp — a
  // screenshot of the internal operations console, complete with the vendor's
  // "PayOps / OPS CONSOLE" wordmark and a named super-admin in the corner.
  // That is the image a customer would have seen when a payment link was
  // pasted into WhatsApp, iMessage or Slack: another company's product, an
  // internal tool, and a staff member's name. The generated card renders this
  // merchant's brand instead, which is the whole point of that file.
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: `${SITE_NAME} — ${HEADLINE}`,
    description: DESCRIPTION,
    siteName: SITE_NAME,
    locale: "en_US",
  },
  // `site` / `creator` are omitted rather than derived from the brand name.
  // `@${SITE_NAME.toLowerCase()}` produced "@rental travels" — a handle with
  // a space in it, which is not a valid Twitter handle and points at nothing.
  // Add them back only with a real account.
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — ${HEADLINE}`,
    description: SHORT_DESCRIPTION,
  },
  // Marketing surfaces are indexable; the authed app is locked behind
  // login. Per-page robots overrides can opt-out (e.g. /pay/success,
  // /consent/[token]) — see those routes for details.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [{ url: "/apple-icon.svg", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  // Verification placeholders — drop real codes when GSC / Bing
  // Webmaster / Yandex / etc. are wired. Empty values are stripped
  // from the head by Next.
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION,
    other: process.env.NEXT_PUBLIC_BING_VERIFICATION
      ? { "msvalidate.01": process.env.NEXT_PUBLIC_BING_VERIFICATION }
      : undefined,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0A" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body
        className="min-h-full bg-background text-foreground"
        suppressHydrationWarning
      >
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
