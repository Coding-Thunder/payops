import Link from "next/link";
import { redirect } from "next/navigation";

import { LogoLockup } from "@/components/brand/logo";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth/session";

import { ForgotPasswordForm } from "./_components/forgot-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  // Already signed in → bounce into the app rather than letting them
  // request a reset for their own active session. To change a
  // password while signed in, the user-edit flow is the right path.
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");

  const brand = env.server.APP_NAME;
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 bg-background">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-4">
          <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
          <div className="space-y-1 pt-1">
            <h1 className="text-[20px] font-semibold tracking-tight">
              Reset your password
            </h1>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              Enter the email tied to your account. We&apos;ll send a link
              that expires in 30 minutes.
            </p>
          </div>
        </div>
        <ForgotPasswordForm
          turnstileSiteKey={env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
        />
        <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed">
          <Link
            href="/login"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
