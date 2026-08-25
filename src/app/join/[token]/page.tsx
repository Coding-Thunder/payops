import { SiteWordmark } from "@/components/brand/site-wordmark";
import { getCurrentUser } from "@/server/auth/session";
import { getInviteForActivation } from "@/server/services/team-invite.service";

import { JoinForm, JoinSignedIn } from "./join-form";

import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  title: "Join your team on TraceTxn",
  description: "Accept a single-use invitation to join a TraceTxn workspace.",
  path: "/join",
  noindex: true,
});

interface JoinPageProps {
  params: Promise<{ token: string }>;
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params;
  // Read-only precheck. Same null for invalid / expired / used / unknown →
  // enumeration-safe.
  const invite = token ? await getInviteForActivation(token) : null;
  const user = await getCurrentUser();

  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <SiteWordmark textClassName="text-foreground" />

        {!invite ? (
          <div className="space-y-3">
            <h1 className="text-[20px] font-semibold tracking-tight">
              This invitation link isn&apos;t valid
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              It may have expired, already been used, or been revoked. Team
              invitations are single-use and expire after 7 days.
            </p>
            <p className="text-[13px] text-muted-foreground">
              Need a new one? Ask a workspace owner to resend your invitation.
            </p>
          </div>
        ) : user ? (
          <div className="space-y-3">
            <h1 className="text-[20px] font-semibold tracking-tight">
              You&apos;re already signed in
            </h1>
            <JoinSignedIn email={user.email} />
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-[20px] font-semibold tracking-tight">
                Join {invite.orgName}
              </h1>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                You&apos;ve been invited to join {invite.orgName} on TraceTxn.
                Set a password to get started.
              </p>
            </div>
            <JoinForm
              token={token}
              email={invite.email}
              defaultName={invite.defaultName}
            />
          </>
        )}
      </div>
    </div>
  );
}
