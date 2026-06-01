import { PageHeader } from "@/components/common/page-header";
import { GatewaysPageContent } from "@/components/features/gateways/gateways-page-content";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { isEncryptionAvailable } from "@/lib/crypto/envelope";
import { requirePermission } from "@/server/auth/session";
import { listGatewayCredentialsForOrg } from "@/server/payments/gateway-credentials.service";
import { env } from "@/lib/env";

export const metadata = { title: "Payment gateways" };
export const dynamic = "force-dynamic";

export default async function AdminGatewaysPage() {
  const user = await requirePermission(Permission.GATEWAY_VIEW);
  const canEdit = roleHasPermission(user.role, Permission.GATEWAY_MANAGE);
  const items = user.orgId
    ? await listGatewayCredentialsForOrg(user.orgId)
    : [];
  const encryptionAvailable = isEncryptionAvailable();
  const webhookUrlBase = env.server.APP_URL;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payment gateway"
        description="Connect Stripe to start accepting payments. Paste your secret key once, we verify it, register the webhook endpoint on your Stripe account automatically, and store everything encrypted."
      />
      <GatewaysPageContent
        items={items}
        orgId={user.orgId}
        canEdit={canEdit}
        encryptionAvailable={encryptionAvailable}
        webhookUrlBase={webhookUrlBase}
      />
    </div>
  );
}
