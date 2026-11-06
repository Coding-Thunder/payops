import type { Metadata } from "next";
import Link from "next/link";

import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Create your workspace",
  description:
    "Create a TraceTxn workspace — free while we're in beta. If you already have an invitation, activate it from the link in your email.",
  path: "/waitlist",
  socialTitle: "Create your workspace • TraceTxn",
});

/**
 * Signup pointer.
 *
 * This route has been three things. It hosted the public "Join the Beta"
 * application; then the form was removed and it became the invite-only
 * notice; now signup is public and it points at `/signup`.
 *
 * ── Why the route still exists ───────────────────────────────────────────
 *
 * `src/app/signup/page.tsx` redirects here when `signupAllowed()` says no,
 * which now only happens if someone sets `SIGNUP_MODE=invite_only`, and
 * `src/proxy.ts` lists `/waitlist` in its public allow-list. Live links also
 * still point here from older emails and posts. Deleting the route would turn
 * that redirect and those links into 404s, so it stays.
 *
 * It is written for the open case, because that is the one visitors arrive
 * in. If signups are ever re-closed, this copy needs revisiting — see
 * `src/server/auth/signup-gate.ts`.
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
            Free beta
          </p>

          <h1 className="mt-7 font-display text-[clamp(2rem,5vw,3.2rem)] font-medium leading-[1.08] tracking-[-0.025em]">
            TraceTxn is{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              open to everyone.
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
            You no longer need an invitation. Create a workspace and keep every
            client&apos;s record in one place — free while we&apos;re in beta.
          </p>

          <div className="mt-8">
            <Link
              href="/signup"
              className="inline-flex h-11 items-center justify-center rounded-md bg-[color:var(--ink-navy)] px-5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Create your workspace
            </Link>
          </div>

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
            Questions before you start?{" "}
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
