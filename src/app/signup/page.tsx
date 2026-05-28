import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckIcon } from "lucide-react";

import { LogoLockup, LogoMark } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { SignupForm } from "./_components/signup-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create your TraceTxn account" };

export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");

  const brand = env.server.APP_NAME;

  return (
    <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      {/* Left panel — dark navy cover sheet, same brand language as
          the landing's hero CoverBand. Replaces the prior Aurora +
          DotGrid marketing chrome. */}
      <section
        className="relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{ background: "var(--ink-navy)" }}
      >
        {/* Subtle radial wash for depth (matches CoverBand) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(ellipse 55% 50% at 85% 25%, color-mix(in oklch, var(--success) 18%, transparent) 0%, transparent 70%)",
          }}
        />

        <LogoLockup
          tone="inverted"
          brand={brand}
          subtitle="Operational payment infrastructure"
          size="md"
          className="relative"
        />

        <div className="relative max-w-md space-y-7">
          <LogoMark className="size-9 text-white" decorated />
          <h2 className="text-balance text-[28px] font-bold leading-[1.12] tracking-tight">
            Run your first paid order
            <br />
            before the day ends.
          </h2>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-white/72">
            Spin up an isolated workspace, connect Stripe, ship a
            payment link. Every transition lands in your hashed
            evidence chain from minute one.
          </p>

          <ul className="space-y-2.5 pt-1 text-[12.5px] text-white/80">
            {[
              "Dispute-grade evidence chain on every order",
              "Per-org Stripe routing — your keys stay encrypted",
              "Branded customer emails out of the box",
            ].map((line) => (
              <li
                key={line}
                className="grid grid-cols-[auto_1fr] items-start gap-2.5"
              >
                <CheckIcon
                  className="mt-[3px] size-3.5 text-success shrink-0"
                  strokeWidth={2.5}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/55">
          Free during preview · cancel anytime
        </p>
      </section>

      {/* Right panel — the form */}
      <section className="flex items-center justify-center bg-background px-6 py-12 sm:px-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-4">
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
            <div className="space-y-1 pt-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Create your workspace
              </h1>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                You&apos;ll be the super-admin. Invite teammates after setup.
              </p>
            </div>
          </div>
          <SignupForm
            turnstileSiteKey={env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
          />
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground/80">
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-foreground underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
