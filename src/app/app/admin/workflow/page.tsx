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
    // A user with the permission but no active workspace is an edge state, not
    // a crash — render an empty-state instead of throwing into the boundary.
    return (
      <div className="space-y-6">
        <PageHeader
          title="Order workflow"
          description="The statuses an order moves through and the transitions between them."
        />
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          <p className="font-medium text-foreground">
            No workspace attached to your account
          </p>
          <p className="mt-1">
            This page needs an active organization. Ask an administrator to add
            you to a workspace.
          </p>
        </div>
      </div>
    );
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
