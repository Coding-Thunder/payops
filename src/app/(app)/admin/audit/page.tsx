import { PageHeader } from "@/components/common/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/common/empty-state";
import { Permission } from "@/lib/constants/permissions";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import { listAuditLogs } from "@/server/services/audit.service";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requirePermission(Permission.AUDIT_VIEW);
  const data = await listAuditLogs({ page: 1, pageSize: 100 });

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
          {data.items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No audit entries yet"
                description="Audit entries are created automatically as users and customers interact with the system."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead className="hidden md:table-cell">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {row.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{row.entityType}</div>
                      {row.entityId ? (
                        <div className="font-mono text-muted-foreground">
                          {row.entityId}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.actorName ?? "system"}
                      {row.actorRole ? (
                        <span className="ml-1 text-muted-foreground">
                          ({row.actorRole})
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-md truncate">
                      {row.metadata ? JSON.stringify(row.metadata) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
