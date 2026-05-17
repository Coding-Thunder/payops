import { redirect } from "next/navigation";

import { Aurora } from "@/components/brand/aurora";
import { DotGrid } from "@/components/brand/illustrations";
import { LogoLockup, LogoMark } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const { next } = await searchParams;
  const brand = env.server.APP_NAME;

  return (
    <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between bg-primary text-primary-foreground p-12 overflow-hidden">
        <Aurora />
        <DotGrid className="absolute inset-0 size-full text-primary-foreground opacity-[0.08]" />
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
            rental payments.
          </h2>
          <p className="text-[13px] leading-relaxed text-primary-foreground/75 max-w-sm">
            Create payable orders, share secure Stripe checkout links with
            customers, and stay in sync with every payment — all from one
            console designed for operations teams.
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
          <LoginForm nextPath={next} />
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
