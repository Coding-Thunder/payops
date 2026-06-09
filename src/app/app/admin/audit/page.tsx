import { PageHeader } from "@/components/common/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuditLogTable } from "@/components/features/audit/audit-log-table";
import { Pagination } from "@/components/features/orders/pagination";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listAuditLogs } from "@/server/services/audit.service";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

interface AuditPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminAuditPage({ searchParams }: AuditPageProps) {
  const actor = await requirePermission(Permission.AUDIT_VIEW);
  const canDelete = roleHasPermission(actor.role, Permission.AUDIT_DELETE);
  const sp = await searchParams;
  const pageParam = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const parsed = Number.parseInt(pageParam ?? "1", 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  const data = await listAuditLogs({ page, pageSize: PAGE_SIZE });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every significant action across the platform - useful for reviews and incident response."
      />
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <AuditLogTable items={data.items} canDelete={canDelete} />
        </CardContent>
      </Card>
      {data.total > 0 ? (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
        />
      ) : null}
    </div>
  );
}
