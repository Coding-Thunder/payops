import { PageHeader } from "@/components/common/page-header";
import { WorkflowBuilder } from "@/components/features/workflow/workflow-builder";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getOrCreateDefaultWorkflow } from "@/server/services/workflow.service";

export const metadata = { title: "Order workflow" };
export const dynamic = "force-dynamic";

export default async function AdminWorkflowPage() {
  const user = await requirePermission(Permission.WORKFLOW_VIEW);
  if (!user.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const workflow = await getOrCreateDefaultWorkflow(user.orgId);
  const canEdit = roleHasPermission(user.role, Permission.WORKFLOW_MANAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Order workflow"
        description="The list of statuses an order can move through and the transitions between them. Defaults match the legacy enum (NOT_INITIATED → … → PAID / FAILED / EXPIRED); customise statuses for your business, pharmacy verification, hotel check-in, SaaS trial, etc. Stripe webhook events always land on the payment-success and payment-failure target keys at the bottom, so re-point those after renaming."
      />
      <WorkflowBuilder initial={workflow} canEdit={canEdit} />
    </div>
  );
}
