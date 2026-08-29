import Image from "next/image";
import { redirect } from "next/navigation";

import { LogoLockup, LogoMark } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { LoginForm } from "./_components/login-form";
import loginBackground from "./_assets/login-bg.jpg";

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
      {/* `bg-primary` stays as the base layer: it is what the copy was
          designed to read against, so a failed or still-loading image
          degrades to the previous panel rather than to unstyled text. */}
      <section className="relative hidden lg:flex flex-col justify-between bg-primary text-primary-foreground p-12 overflow-hidden">
        {/* Statically imported, so Next fingerprints this into
            /_next/static/media and serves it immutable for a year with an
            AVIF/WebP srcset — no request-time work on the login path.
            `sizes` collapses the candidate to ~1px below `lg`, where the
            panel is display:none, so small viewports pay nothing for it. */}
        <Image
          src={loginBackground}
          alt=""
          aria-hidden
          fill
          priority
          placeholder="blur"
          sizes="(min-width: 1024px) 52vw, 1px"
          className="object-cover object-[68%_center] select-none"
        />
        {/* Two-stop scrim. The subject is framed right of centre, so the
            horizontal pass darkens the left column the copy occupies while
            leaving the mask legible; the vertical pass seats the footer
            line. Tuned to keep body text above 4.5:1 on the panel. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/60 to-black/15"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/45"
        />
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
