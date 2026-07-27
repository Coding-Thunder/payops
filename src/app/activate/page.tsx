import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteWordmark } from "@/components/brand/site-wordmark";
import { getCurrentUser } from "@/server/auth/session";
import { turnstileSiteKey } from "@/server/auth/turnstile";
import { getApplicationForActivation } from "@/server/services/beta-application.service";

import { ActivateForm } from "./activate-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activate your TraceTxn account" };

interface ActivatePageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ActivatePage({
  searchParams,
}: ActivatePageProps) {
  const user = await getCurrentUser();
  if (user) redirect("/app/dashboard");

  const { token } = await searchParams;
  const app = token ? await getApplicationForActivation(token) : null;

  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <SiteWordmark textClassName="text-foreground" />

        {!app || !token ? (
          <div className="space-y-3">
            <h1 className="text-[20px] font-semibold tracking-tight">
              This invitation link isn&apos;t valid
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              It may have expired, already been used, or been revoked. Beta
              invitations are single-use and expire after 7 days.
            </p>
            <p className="text-[13px] text-muted-foreground">
              Haven&apos;t applied yet?{" "}
              <Link
                href="/waitlist"
                className="text-foreground underline-offset-4 hover:underline"
              >
                Apply for the beta
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Activate your account
              </h1>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                You&apos;ve been approved for the private beta. Set a password to
                finish setting up your workspace.
              </p>
            </div>
            <ActivateForm
              token={token}
              email={app.email}
              defaultName={app.fullName}
              turnstileSiteKey={turnstileSiteKey()}
            />
          </>
        )}
      </div>
    </div>
  );
}
