import Link from "next/link";

import { LogoLockup } from "@/components/brand/logo";
import { env } from "@/lib/env";

import { ResetPasswordForm } from "../_components/reset-password-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset your password" };

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function ResetPasswordPage({ params }: PageProps) {
  const { token } = await params;
  const brand = env.server.APP_NAME;

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 bg-background">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-4">
          <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
          <div className="space-y-1 pt-1">
            <h1 className="text-[20px] font-semibold tracking-tight">
              Set a new password
            </h1>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              Choose a fresh password. The link expires 30 minutes
              after it was sent.
            </p>
          </div>
        </div>
        <ResetPasswordForm token={token} />
        <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed">
          Remembered it after all?{" "}
          <Link
            href="/login"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
