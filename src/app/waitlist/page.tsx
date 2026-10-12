import type { Metadata } from "next";
import Link from "next/link";

import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Invite-only access",
  description:
    "TraceTxn is in private beta and access is invite-only. There is no public application; if you already have an invitation, activate it from the link in your email.",
  path: "/waitlist",
  socialTitle: "Invite-only access • TraceTxn",
});

/**
 * Invite-only notice.
 *
 * This route used to host the public "Join the Beta" application. The form is
 * gone: there is no longer a public way to apply, so the page states the
 * access model and stops.
 *
 * ── Why the route still exists ───────────────────────────────────────────
 *
 * `src/app/signup/page.tsx` redirects here when a visitor has no accepted
 * invite (`signupInviteAccepted()`), and `src/proxy.ts` lists `/waitlist` in
 * its public allow-list. Deleting the route would turn that redirect into a
 * 404, so it stays and answers the question the redirect implies: you need an
 * invitation, and here is what to do if you have one.
 *
 * Nothing here posts anywhere. `/api/beta/apply` is untouched and still
 * serves the admin-side application records; it simply has no public caller.
 */
export default function WaitlistPage() {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background: "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
          }}
        />

        <div className="mx-auto max-w-[680px] px-6 pt-20 pb-24 text-center sm:px-10 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Private beta
          </p>

          <h1 className="mt-7 font-display text-[clamp(2rem,5vw,3.2rem)] font-medium leading-[1.08] tracking-[-0.025em]">
            TraceTxn is{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              invite-only.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
            We&apos;re working with a small group of agencies and freelancers
            while we build the product. There is no public application at the
            moment.
          </p>

          <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-white p-6 text-left">
            <p className="font-display text-[14px] font-semibold text-foreground">
              Already have an invitation?
            </p>
            <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
              Activate it from the link in your invitation email. Once your
              workspace exists you can sign in here any time.
            </p>
            <Link
              href="/login"
              className="mt-5 inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-4 text-[13px] font-semibold text-background transition-opacity hover:opacity-90"
            >
              Sign in
            </Link>
          </div>

          <p className="mx-auto mt-10 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            Want to know when access opens up more widely?{" "}
            <Link
              href="/contact"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Get in touch
            </Link>
            .
          </p>
        </div>
      </section>

      <BrandFooter />
    </div>
  );
}
