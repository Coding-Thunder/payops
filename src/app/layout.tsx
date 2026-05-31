import type { Metadata, Viewport } from "next";
import { DM_Sans, Geist, Geist_Mono } from "next/font/google";

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

/** Brand-v1 display typeface — DM Sans. Used on the wordmark + on
 *  display-scale headings via the Tailwind `font-display` utility
 *  (token `--font-display`, declared in globals.css). Body copy
 *  stays on Geist for legibility at small sizes. */
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
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

const SITE_NAME = process.env.NEXT_PUBLIC_APP_NAME || "TraceTxn";
const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://tracetxn.example.com"
).replace(/\/$/, "");
const HEADLINE = "Payment Operations Platform · Dispute & Chargeback Evidence";
const DESCRIPTION =
  "TraceTxn is the payment operations platform built for the full order lifecycle. Lifecycle visibility, hashed evidence chain, hosted consent, and multi-gateway orchestration — for retail, services, repair, dealership, B2B, and every commerce shape that takes money seriously.";
const SHORT_DESCRIPTION =
  "Lifecycle visibility, hashed dispute evidence, and multi-gateway orchestration — operational infrastructure for modern commerce.";
const OG_IMAGE = `${SITE_URL}/marketing/evidence-chain.webp`;

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
  keywords: [
    // Core positioning
    "payment operations",
    "payment operations platform",
    "payment operations software",
    "payment ops",
    "payment ops platform",
    // Disputes / chargebacks (highest commercial intent)
    "chargeback evidence",
    "chargeback management",
    "chargeback defense",
    "dispute evidence",
    "dispute management software",
    "dispute readiness",
    "chargeback prevention",
    "stripe dispute management",
    "stripe chargeback evidence",
    // Multi-gateway / orchestration
    "payment orchestration",
    "multi gateway payments",
    "multi gateway orchestration",
    "payment routing",
    "stripe alternative",
    // Audit / compliance
    "payment audit trail",
    "payment audit log",
    "hashed evidence chain",
    "soc compliance payments",
    "payment compliance platform",
    // Customer trust / consent
    "payment consent capture",
    "hosted consent flow",
    "customer authorization",
    // Webhook ops
    "webhook idempotency",
    "stripe webhook reliability",
    // Brand / generic
    "fintech",
    "enterprise payments",
    "order lifecycle platform",
    "commerce operations platform",
    "multi tenant payment platform",
    "self serve payment operations",
    "b2b payment workflows",
    "order workflow software",
    "payment evidence platform",
    "merchant audit trail",
    "consent capture platform",
    "payment ops console",
    "payment ops center",
    "payment control tower",
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
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: `${SITE_NAME} — ${HEADLINE}`,
    description: DESCRIPTION,
    siteName: SITE_NAME,
    locale: "en_US",
    images: [
      {
        url: OG_IMAGE,
        width: 1440,
        height: 900,
        alt: `${SITE_NAME} — evidence chain for a disputed order`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: `@${SITE_NAME.toLowerCase()}`,
    creator: `@${SITE_NAME.toLowerCase()}`,
    title: `${SITE_NAME} — ${HEADLINE}`,
    description: SHORT_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        alt: `${SITE_NAME} — evidence chain for a disputed order`,
      },
    ],
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
  // Icons are auto-injected from the file-convention assets:
  //   - src/app/icon.svg          -> <link rel="icon" href="/icon">
  //   - src/app/apple-icon.tsx    -> <link rel="apple-touch-icon" href="/apple-icon">
  // Don't override `icons` here — explicit overrides win over the
  // conventions and the prior list pointed at /favicon.ico and
  // /apple-icon.svg, neither of which exist.
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
    { media: "(prefers-color-scheme: light)", color: "#F8FAFC" },
    { media: "(prefers-color-scheme: dark)", color: "#0F172A" },
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
      className={`${geistSans.variable} ${geistMono.variable} ${dmSans.variable} antialiased`}
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
