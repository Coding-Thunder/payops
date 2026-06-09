"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IntegrityBadge } from "@/components/features/evidence/integrity-badge";
import { api, ApiClientError } from "@/lib/api-client";
import { OrderEvidenceEventLabel } from "@/lib/constants/labels";
import {
  type OrderEvidenceEventType,
  type UserRole,
} from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { OrderEvidenceVerificationDTO } from "@/types";

interface OrderEvidenceCardProps {
  orderId: string;
  role: UserRole;
}

interface SummaryResponse {
  eventCount: number;
  lastEventType: OrderEvidenceEventType | null;
  lastEventAt: string | null;
  verification: OrderEvidenceVerificationDTO;
}

/**
 * Summary card surfaced on the order detail page. Hidden for any role
 * lacking EVIDENCE_VIEW (staff get a 403 from the underlying API; we
 * preempt the render to avoid noisy network errors).
 *
 * The summary endpoint returns just integrity + event count + last
 * event, full chain stays on `/orders/:id/evidence`.
 */
export function OrderEvidenceCard({
  orderId,
  role,
}: OrderEvidenceCardProps) {
  const canView = roleHasPermission(role, Permission.EVIDENCE_VIEW);
  const { data, error, isLoading } = useQuery({
    queryKey: ["order", orderId, "evidence-summary"],
    queryFn: () =>
      api.get<SummaryResponse>(`/api/orders/${orderId}/evidence/summary`),
    enabled: canView,
    staleTime: 30_000,
    retry: (count, err) => {
      if (err instanceof ApiClientError && err.status === 403) return false;
      return count < 2;
    },
  });

  if (!canView) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheckIcon className="size-4" />
          Evidence chain
        </CardTitle>
        <CardDescription>
          Hash-chained record of this order&apos;s lifecycle. Open the full
          chain for dispute defense or to view captured emails.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-[12.5px]">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : error ? (
          <p className="text-muted-foreground">Could not load chain summary.</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
              <div className="text-muted-foreground">Integrity</div>
              <div>
                <IntegrityBadge verification={data.verification} />
              </div>
              <div className="text-muted-foreground">Events</div>
              <div className="font-medium">{data.eventCount}</div>
              <div className="text-muted-foreground">Last event</div>
              <div>
                {data.lastEventType ? (
                  <>
                    {OrderEvidenceEventLabel[data.lastEventType] ??
                      data.lastEventType}
                    {data.lastEventAt ? (
                      <span className="ml-1 text-muted-foreground">
                        · {formatRelative(data.lastEventAt)}
                        <span className="hidden sm:inline">
                          {" · "}
                          {formatDateTime(data.lastEventAt)}
                        </span>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">No events yet</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild size="sm">
                <Link href={`/app/orders/${orderId}/evidence`}>Open evidence</Link>
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
