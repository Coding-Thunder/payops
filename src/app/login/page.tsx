import { redirect } from "next/navigation";

import { Aurora } from "@/components/brand/aurora";
import { DotGrid } from "@/components/brand/illustrations";
import { LogoLockup, LogoMark } from "@/components/brand/logo";
import Image from "next/image";

import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");
  const { next } = await searchParams;
  const brand = env.server.APP_NAME;
  // Optional. Set to the asset id returned when the backdrop was uploaded to
  // the asset store; unset simply keeps the previous gradient panel.
  const bgId = process.env.LOGIN_BACKGROUND_ASSET_ID?.trim();
  const loginBackgroundUrl =
    bgId && /^[a-f0-9]{24}$/i.test(bgId) ? `/api/assets/${bgId}` : null;

  return (
    <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between bg-primary text-primary-foreground p-12 overflow-hidden">
        {/* Full-bleed backdrop.
            Served from the durable asset store (GridFS) rather than a
            `public/` runtime write, with the immutable cache header the
            /api/assets route sets — so it is fetched once per browser, not
            on every login. `LOGIN_BACKGROUND_ASSET_ID` is optional: when it
            is unset the panel falls back to the existing Aurora/DotGrid
            treatment, so a missing asset can never break sign-in.
            `priority` because this is the LCP element on the page. */}
        {loginBackgroundUrl ? (
          <>
            <Image
              src={loginBackgroundUrl}
              alt=""
              fill
              priority
              sizes="(min-width: 1024px) 52vw, 0px"
              className="absolute inset-0 object-cover object-top"
            />
            {/* Two stacked gradients rather than one flat scrim, because the
                copy and the subject occupy DIFFERENT halves of the panel:
                all text sits left, the face sits centre-right.

                The horizontal pass darkens the left column so the headline
                and body keep well clear of 4.5:1, then falls to transparent
                on the right so the subject is genuinely visible rather than
                greyed out. The vertical pass is deliberately light — just
                enough to seat the top lockup and the bottom legal line. */}
            <div className="absolute inset-0 bg-gradient-to-r from-primary via-primary/75 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-primary/85 via-transparent to-primary/45" />
          </>
        ) : (
          <>
            <Aurora />
            <DotGrid className="absolute inset-0 size-full text-primary-foreground opacity-[0.08]" />
          </>
        )}
        <LogoLockup
          tone="inverted"
          brand={brand}
          subtitle="Payment operations"
          size="md"
          className="relative"
        />
        <div className="relative space-y-6 max-w-md">
          <LogoMark
            className="size-9 text-primary-foreground/90"
            decorated
          />
          <h2 className="text-[28px] font-semibold tracking-tight leading-[1.15]">
            Reliable, auditable
            <br />
            payment operations.
          </h2>
          <p className="text-[13px] leading-relaxed text-primary-foreground/75 max-w-sm">
            Track the full payment lifecycle, capture dispute-grade
            evidence, and orchestrate gateways — all from one console
            built for operations, finance, and trust teams.
          </p>
        </div>
        <div className="relative text-[11px] tracking-wider uppercase text-primary-foreground/55">
          Authorized access only · Activity is recorded
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-12 bg-background">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-4">
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
            <div className="space-y-1 pt-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Sign in to your account
              </h1>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                Use the credentials your administrator gave you.
              </p>
            </div>
          </div>
          <LoginForm
            nextPath={next}
            turnstileSiteKey={env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
          />
          <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed">
            Trouble signing in? Reach out to your administrator.
            <br />
            Public sign-ups are disabled.
          </p>
        </div>
      </section>
    </div>
  );
}
