import type { Metadata, Viewport } from "next";
import { DM_Sans, Geist, Geist_Mono } from "next/font/google";

import { ClarityAnalytics } from "@/components/analytics/clarity-analytics";
import { AppProviders } from "@/components/providers/app-providers";
import { env } from "@/lib/env";
import {
  DESCRIPTION,
  HEADLINE,
  KEYWORDS,
  SHORT_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "@/lib/seo";

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

/** Brand-v1 display typeface, DM Sans. Used on the wordmark + on
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
 * Strategy: shared defaults only — title template, `metadataBase`,
 * OG/Twitter card shape, theme color, viewport. Every public page supplies
 * its own title, description and SELF-REFERENCING canonical through
 * `pageMetadata()` in `@/lib/seo`.
 *
 * What this root deliberately does NOT declare:
 *
 *  - a canonical. Next merges `alternates` wholesale, so a root canonical
 *    silently made every non-overriding page a declared duplicate of `/`.
 *  - `openGraph.images`. `src/app/opengraph-image.tsx` is a file convention
 *    and wins regardless, so a static entry here was dead config.
 *
 * Marketing intent: the audience is an agency or freelancer looking for a
 * place to keep client history, not a payments lead shopping for dispute
 * tooling. The keyword list is small and lives in `@/lib/seo`; Google
 * ignores the meta tag entirely, so it survives only as a statement of
 * intent for whoever edits this next.
 */

// Positioning constants live in `@/lib/seo` so metadata, JSON-LD, the
// sitemap and the OG image cannot drift apart again.

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME}, ${HEADLINE}`,
    template: `%s • ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  generator: "Next.js",
  referrer: "strict-origin-when-cross-origin",
  // The product is business software for service firms, not a
  // financial product. "fintech" biased every classifier that reads it.
  category: "business",
  classification: "business",
  keywords: KEYWORDS,
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  manifest: "/manifest.webmanifest",
  // NO root canonical. Next merges `alternates` wholesale, so declaring one
  // here made every page that did not override it canonicalise to `/` —
  // telling Google that /features, /pricing and /security were duplicates of
  // the homepage. Each public page now sets its own via `pageMetadata()`.
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: `${SITE_NAME}, ${HEADLINE}`,
    description: DESCRIPTION,
    siteName: SITE_NAME,
    locale: "en_US",
    // No `images` here on purpose: src/app/opengraph-image.tsx is a file
    // convention and takes precedence, so a static entry was dead config
    // pointing at /marketing/evidence-chain.webp — a screenshot that still
    // carries the pre-rename "PayOps" chrome.
  },
  twitter: {
    card: "summary_large_image",
    site: `@${SITE_NAME.toLowerCase()}`,
    creator: `@${SITE_NAME.toLowerCase()}`,
    title: `${SITE_NAME}, ${HEADLINE}`,
    description: SHORT_DESCRIPTION,
  },
  // Marketing surfaces are indexable; the authed app is locked behind
  // login. Per-page robots overrides can opt-out (e.g. /pay/success,
  // /consent/[token]), see those routes for details.
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
  // Don't override `icons` here, explicit overrides win over the
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
  // Verification placeholders, drop real codes when GSC / Bing
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
        {/* Microsoft Clarity. Mounted once here so there is a single
            injection site, but it loads on the public marketing routes
            ONLY — see the allow-list and the reasoning in
            `@/lib/analytics/clarity`. Renders null when
            NEXT_PUBLIC_CLARITY_PROJECT_ID is unset, so an environment
            that has not configured it loads no third-party script. The
            id is read here, on the server, and threaded down as a prop,
            matching how the Turnstile site key is handled. */}
        <ClarityAnalytics
          projectId={env.public.NEXT_PUBLIC_CLARITY_PROJECT_ID ?? null}
        />
      </body>
    </html>
  );
}
