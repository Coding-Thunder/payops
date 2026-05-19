import { FileSignatureIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  OrderEvidenceEventType,
} from "@/lib/constants/enums";
import { formatDateTime, formatIp } from "@/lib/format";
import type { OrderEvidenceEventDTO } from "@/types";

interface ConsentEvidenceCardProps {
  events: OrderEvidenceEventDTO[];
}

/**
 * Distills the consent evidence (request → receive → verify) into a
 * focused card. This is the single piece a bank will ask for first
 * when disputing: typed signature, IP, UA, method, and exact statement
 * the customer agreed to.
 */
export function ConsentEvidenceCard({ events }: ConsentEvidenceCardProps) {
  const received = findLast(
    events,
    OrderEvidenceEventType.CONSENT_RECEIVED,
  );
  const requested = findLast(
    events,
    OrderEvidenceEventType.CONSENT_REQUESTED,
  );
  const verified = findLast(
    events,
    OrderEvidenceEventType.CONSENT_VERIFIED,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSignatureIcon className="size-4" />
          Consent evidence
        </CardTitle>
        <CardDescription>
          The single piece banks ask for first in a chargeback. Captured
          server-side at the moment the customer clicked &ldquo;I agree&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-[12.5px]">
        {!received ? (
          <p className="text-muted-foreground">
            Customer has not confirmed consent yet.
          </p>
        ) : (
          <div className="space-y-2">
            <Row label="Status">
              {verified ? (
                <Badge variant="success">Verified</Badge>
              ) : (
                <Badge variant="info">Received</Badge>
              )}
            </Row>
            <Row label="Signed name">
              <span className="font-medium">
                {valueOf(received, "signedName") ?? "—"}
              </span>
            </Row>
            <Row label="Statement">
              <span className="text-muted-foreground">
                {valueOf(received, "consentMessage") ?? "—"}
              </span>
            </Row>
            <Row label="Acknowledgement (echoed)">
              <span className="text-muted-foreground">
                {valueOf(received, "acknowledgement") ?? "—"}
              </span>
            </Row>
            <Row label="Method">
              {valueOf(received, "method") ?? "—"}
            </Row>
            <Row label="Received at">
              {formatDateTime(received.occurredAt)}
            </Row>
            <Row label="IP">{formatIp(received.request?.ip)}</Row>
            <Row label="User agent">
              <span className="break-all">
                {received.request?.userAgent ?? "—"}
              </span>
            </Row>
            <Row label="Consent token hash">
              <span className="font-mono text-[11px] break-all">
                {received.refs?.consentTokenHash ?? "—"}
              </span>
            </Row>
            <Row label="Payload hash">
              <span className="font-mono text-[11px] break-all">
                {received.snapshotHash}
              </span>
            </Row>
            {requested ? (
              <Row label="Originally requested">
                {formatDateTime(requested.occurredAt)} by{" "}
                {requested.actor.name ?? "agent"}
              </Row>
            ) : null}
            {verified ? (
              <Row label="Verified by">
                {verified.actor.name ?? "—"} on{" "}
                {formatDateTime(verified.occurredAt)}
              </Row>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-x-3 gap-y-1">
      <div className="text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function findLast(
  events: OrderEvidenceEventDTO[],
  type: OrderEvidenceEventDTO["eventType"],
) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].eventType === type) return events[i];
  }
  return null;
}

function valueOf(
  event: OrderEvidenceEventDTO,
  key: string,
): string | null {
  const v = event.payload[key];
  return typeof v === "string" ? v : null;
}
