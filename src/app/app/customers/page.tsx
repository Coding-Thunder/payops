import Link from "next/link";
import { UsersRoundIcon } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ClientFilters } from "@/components/features/clients/client-filters";
import { Pagination } from "@/components/features/orders/pagination";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Permission } from "@/lib/constants/permissions";
import { formatRelative, initialsFromName } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import { listClients } from "@/server/services/client-profile.service";

export const metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

interface ClientsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Clients — the permanent per-customer records that outlive any single
 * order. This is the roster: searchable, sortable, paginated. Each row
 * is a link into the full Client Profile (lifetime aggregates + timeline).
 *
 * Read surface only; identity edits happen inside the profile. Tenant
 * scoping is enforced by `listClients` (never trust the client).
 */
export default async function ClientsPage({ searchParams }: ClientsPageProps) {
  const user = await requirePermission(Permission.CUSTOMER_VIEW);
  const sp = await searchParams;

  const search = typeof sp.q === "string" ? sp.q : undefined;
  const sort = typeof sp.sort === "string" ? sp.sort : undefined;
  const page = typeof sp.page === "string" ? Number(sp.page) || 1 : 1;

  const data = await listClients(user.orgId, { search, sort, page });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description="Every customer you've transacted with — a permanent record that outlives any single order."
      />

      <ClientFilters />

      {data.items.length === 0 ? (
        <EmptyState
          icon={<UsersRoundIcon className="size-5" />}
          title={search ? "No matching clients" : "No clients yet"}
          description={
            search
              ? "Try a different name, email, phone, or company."
              : "Clients appear here automatically the first time you create an order for them."
          }
        />
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="hidden md:table-cell">
                      Company
                    </TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="hidden sm:table-cell text-right">
                      Last activity
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((c) => (
                    <TableRow key={c.id} className="group">
                      <TableCell>
                        <Link
                          href={`/app/customers/${c.id}`}
                          className="flex items-center gap-3"
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-muted-foreground">
                            {initialsFromName(c.name || c.email)}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground group-hover:underline">
                              {c.name || c.email}
                            </span>
                            <span className="block truncate text-[12px] text-muted-foreground">
                              {c.email}
                              {c.phone ? ` · ${c.phone}` : ""}
                            </span>
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {c.company ? (
                          <span className="text-[13px] text-foreground">
                            {c.company}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.ordersCount > 0 ? (
                          <Badge variant="secondary">{c.ordersCount}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right text-[13px] text-muted-foreground">
                        {c.lastOrderAt ? formatRelative(c.lastOrderAt) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
          />
        </>
      )}
    </div>
  );
}
