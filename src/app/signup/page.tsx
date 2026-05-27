import Link from "next/link";
import { redirect } from "next/navigation";

import { Aurora } from "@/components/brand/aurora";
import { DotGrid } from "@/components/brand/illustrations";
import { LogoLockup, LogoMark } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { SignupForm } from "./_components/signup-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create your PayOps account" };

export default async function SignupPage() {
  // Already signed in → drop them into the app instead of letting
  // them register a second tenant under the same session. Org-switch
  // / multi-org membership is a future surface.
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");

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
            Start collecting
            <br />
            payments in minutes.
          </h2>
          <p className="text-[13px] leading-relaxed text-primary-foreground/75 max-w-sm">
            Spin up an isolated workspace, bring your own Stripe
            credentials, and start operating. No phone calls, no
            sales demo — just sign up and go.
          </p>
          <ul className="text-[12px] text-primary-foreground/70 space-y-1.5 pt-2">
            <li>• Dispute-grade evidence chain on every order</li>
            <li>• Per-org Stripe routing, your keys never leave Mongo</li>
            <li>• Branded customer emails out of the box</li>
          </ul>
        </div>
        <div className="relative text-[11px] tracking-wider uppercase text-primary-foreground/55">
          Free during preview · Cancel anytime
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-12 bg-background">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-4">
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
            <div className="space-y-1 pt-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Create your workspace
              </h1>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                You'll be the super-admin. Invite teammates after setup.
              </p>
            </div>
          </div>
          <SignupForm
            turnstileSiteKey={env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
          />
          <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed">
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
