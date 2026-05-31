import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckIcon } from "lucide-react";

import { FirebaseAuthForm } from "@/components/auth/firebase-auth-form";
import { LogoLockup, LogoMark } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";
import { turnstileSiteKey } from "@/server/auth/turnstile";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");
  const { next } = await searchParams;
  const brand = env.server.APP_NAME;

  return (
    <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      {/* Left panel — Unsplash photo behind a dark gradient overlay
          so the white brand text + accents stay readable. To swap the
          photo, change the `unsplashUrl` constant. */}
      <section
        className="relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{ background: "var(--ink-navy)" }}
      >
        {/* Bottom layer: Unsplash photo (cover-fit, slightly desaturated
            via brightness so the brand emerald reads on top). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-20 bg-cover bg-center"
          style={{
            backgroundImage:
              "url(https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1600&q=80)",
            filter: "brightness(0.55) saturate(0.85)",
          }}
        />
        {/* Middle layer: dark gradient so text remains legible at the
            top-left + bottom-left where copy lives. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklch, var(--ink-navy) 88%, transparent) 0%, color-mix(in oklch, var(--ink-navy) 55%, transparent) 60%, color-mix(in oklch, var(--ink-navy) 88%, transparent) 100%)",
          }}
        />
        {/* Top layer: existing emerald radial wash — unchanged so the
            brand accent still reads through the photo. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0"
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
            Reliable, auditable payment operations.
          </h2>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-white/72">
            Track the full payment lifecycle, capture dispute-grade
            evidence, and orchestrate gateways — all from one console
            built for operations, finance, and trust teams.
          </p>
          <ul className="space-y-2.5 pt-1 text-[12.5px] text-white/80">
            {[
              "Hashed evidence chain on every order",
              "Per-org Stripe routing — your keys stay encrypted",
              "Realtime SSE lifecycle updates",
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
          Authorized access only · Activity is recorded
        </p>
      </section>

      <section className="flex items-center justify-center bg-background px-6 py-12 sm:px-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-4">
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
            <div className="space-y-1 pt-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Sign in to your account
              </h1>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Use Google or your work email + password.
              </p>
            </div>
          </div>
          <FirebaseAuthForm
            mode="signin"
            nextPath={next}
            turnstileSiteKey={turnstileSiteKey()}
          />
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground/80">
            Don&apos;t have an account yet?{" "}
            <Link
              href="/signup"
              className="text-foreground underline-offset-4 hover:underline"
            >
              Create your workspace
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
