import "server-only";

import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

import {
  OrderEvidenceActorLabel,
  OrderEvidenceEventLabel,
} from "@/lib/constants/labels";
import { formatCurrency, formatIp } from "@/lib/format";
import type { OrderEvidenceChainDTO, OrderEvidenceEventDTO } from "@/types";

/**
 * Dispute packet rendered as a PDF. Layout aims at "legal-grade":
 * monospaced hashes, tabular event list, prominent integrity status,
 * captured emails reduced to their key fields (the full HTML viewer
 * stays on the web page; embedding 100KB+ HTML per email blows up
 * the PDF size with no extra evidentiary value).
 */

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: 9,
    fontFamily: "Helvetica",
    color: "#0f172a",
    backgroundColor: "#ffffff",
  },
  h1: { fontSize: 16, fontWeight: 700, marginBottom: 4 },
  h2: { fontSize: 11, fontWeight: 700, marginTop: 18, marginBottom: 6 },
  meta: { fontSize: 8, color: "#64748b", marginBottom: 14 },
  row: { flexDirection: "row", marginBottom: 2 },
  rowLabel: { width: 110, color: "#64748b" },
  rowValue: { flex: 1 },
  divider: {
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: 1,
    marginVertical: 6,
  },
  pill: {
    backgroundColor: "#dcfce7",
    color: "#166534",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: "flex-start",
    fontSize: 8,
  },
  pillBroken: {
    backgroundColor: "#fee2e2",
    color: "#991b1b",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: "flex-start",
    fontSize: 8,
  },
  card: {
    borderColor: "#e2e8f0",
    borderWidth: 1,
    borderRadius: 4,
    padding: 8,
    marginBottom: 6,
  },
  imagesRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    marginBottom: 6,
  },
  imageTile: {
    borderColor: "#e2e8f0",
    borderWidth: 1,
    borderRadius: 4,
    width: "48%",
    padding: 6,
    alignItems: "center",
  },
  imageTileLabel: {
    fontSize: 7,
    fontWeight: 700,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    alignSelf: "flex-start",
  },
  imageTileImg: {
    height: 70,
    width: "100%",
    objectFit: "contain",
    marginTop: 4,
    marginBottom: 4,
  },
  imageTileCaption: {
    fontSize: 8,
    color: "#0f172a",
    alignSelf: "flex-start",
  },
  eventHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 3,
  },
  eventTitle: { fontWeight: 700, fontSize: 10 },
  hashMono: {
    fontFamily: "Courier",
    fontSize: 7,
    color: "#475569",
    marginTop: 2,
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 36,
    right: 36,
    fontSize: 7,
    color: "#94a3b8",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  table: { width: "100%", marginTop: 6 },
  tableRow: {
    flexDirection: "row",
    borderBottomColor: "#e2e8f0",
    borderBottomWidth: 0.5,
    paddingVertical: 3,
  },
  tableHeadRow: {
    flexDirection: "row",
    borderBottomColor: "#0f172a",
    borderBottomWidth: 1,
    paddingBottom: 3,
    fontSize: 8,
    fontWeight: 700,
    color: "#475569",
  },
  col1: { width: 30 },
  col2: { width: 130 },
  col3: { width: 110 },
  col4: { flex: 1 },
});

interface EvidenceDocumentProps {
  chain: OrderEvidenceChainDTO;
  generatedAt: Date;
}

export function EvidenceDocument({
  chain,
  generatedAt,
}: EvidenceDocumentProps) {
  const { order, events, verification } = chain;
  return (
    <Document
      title={`Evidence — ${order.orderNumber}`}
      author={`Dispute team`}
      subject={`Order ${order.orderNumber}`}
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Order evidence — {order.orderNumber}</Text>
        <Text style={styles.meta}>
          Generated {generatedAt.toISOString()} · {events.length} event
          {events.length === 1 ? "" : "s"} ·{" "}
          {verification.valid
            ? "Integrity: VALID"
            : `Integrity: BROKEN at #${verification.brokenAtSequence ?? "?"}`}
        </Text>

        <View style={[verification.valid ? styles.pill : styles.pillBroken]}>
          <Text>
            {verification.valid
              ? "Chain integrity verified"
              : `Chain broken at sequence #${verification.brokenAtSequence ?? "?"} — ${
                  verification.reason ?? "unknown"
                }`}
          </Text>
        </View>

        <Text style={styles.h2}>Order header</Text>
        <Row label="Order number" value={order.orderNumber} />
        <Row label="Status" value={order.status} />
        <Row label="Customer" value={order.customer.name} />
        <Row label="Email" value={order.customer.email} />
        <Row label="Phone" value={order.customer.phone} />
        <Row
          label="Amount"
          value={formatCurrency(order.pricing.amount, order.pricing.currency)}
        />
        <Row label="Provider" value={order.provider?.name ?? "—"} />
        <Row
          label="Vehicle"
          value={`${order.vehicle.company} · ${order.vehicle.type}`}
        />
        <Row label="Created" value={order.createdAt} />

        <View style={styles.imagesRow}>
          {order.provider?.logo ? (
            <View style={styles.imageTile}>
              <Text style={styles.imageTileLabel}>Provider</Text>
              <Image
                src={order.provider.logo}
                style={styles.imageTileImg}
              />
              <Text style={styles.imageTileCaption}>{order.provider.name}</Text>
            </View>
          ) : null}
          {order.vehicle.imageUrl ? (
            <View style={styles.imageTile}>
              <Text style={styles.imageTileLabel}>Vehicle</Text>
              <Image
                src={order.vehicle.imageUrl}
                style={styles.imageTileImg}
              />
              <Text style={styles.imageTileCaption}>
                {order.vehicle.company} · {order.vehicle.type}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.h2}>Consent evidence</Text>
        <ConsentBlock events={events} />

        <Text style={styles.h2}>Payment evidence</Text>
        <PaymentBlock events={events} />

        <Text style={styles.h2}>Email evidence</Text>
        <EmailBlock events={events} />

        <View style={styles.footer} fixed>
          <Text>{order.orderNumber}</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>

      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.h1}>Event chain</Text>
        <Text style={styles.meta}>
          Each event is sha256-hashed against the prior event. Mutating any
          payload field would break every downstream hash and be caught by
          the verification block above.
        </Text>
        {events.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            isBroken={verification.brokenAtSequence === event.sequence}
          />
        ))}

        <Text style={styles.h2}>Hash summary</Text>
        <View style={styles.table}>
          <View style={styles.tableHeadRow}>
            <Text style={styles.col1}>#</Text>
            <Text style={styles.col2}>Event</Text>
            <Text style={styles.col3}>Occurred</Text>
            <Text style={styles.col4}>Hash</Text>
          </View>
          {events.map((event) => (
            <View key={event.id} style={styles.tableRow}>
              <Text style={styles.col1}>{event.sequence}</Text>
              <Text style={styles.col2}>
                {OrderEvidenceEventLabel[event.eventType] ?? event.eventType}
              </Text>
              <Text style={styles.col3}>{event.occurredAt}</Text>
              <Text style={[styles.col4, styles.hashMono]}>{event.hash}</Text>
            </View>
          ))}
        </View>

        <View style={styles.footer} fixed>
          <Text>{order.orderNumber}</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function EventCard({
  event,
  isBroken,
}: {
  event: OrderEvidenceEventDTO;
  isBroken: boolean;
}) {
  return (
    <View style={styles.card} wrap={false}>
      <View style={styles.eventHeader}>
        <Text style={styles.eventTitle}>
          #{event.sequence} ·{" "}
          {OrderEvidenceEventLabel[event.eventType] ?? event.eventType}
        </Text>
        <Text>{event.occurredAt}</Text>
      </View>
      <Row label="Actor" value={renderActor(event)} />
      {event.request?.ip ? <Row label="IP" value={formatIp(event.request.ip)} /> : null}
      {event.request?.userAgent ? (
        <Row label="User agent" value={event.request.userAgent} />
      ) : null}
      {renderRefs(event)}
      {isBroken ? (
        <View style={[styles.pillBroken, { marginTop: 4 }]}>
          <Text>Chain breaks here</Text>
        </View>
      ) : null}
      <View style={styles.divider} />
      <Text style={styles.hashMono}>snapshotHash: {event.snapshotHash}</Text>
      <Text style={styles.hashMono}>
        previousHash: {event.previousHash ?? "GENESIS"}
      </Text>
      <Text style={styles.hashMono}>hash: {event.hash}</Text>
    </View>
  );
}

function renderActor(event: OrderEvidenceEventDTO): string {
  const role = OrderEvidenceActorLabel[event.actor.type];
  const name = event.actor.name ?? "—";
  const email = event.actor.email ?? "";
  return `${role} · ${name}${email ? ` <${email}>` : ""}`;
}

function renderRefs(event: OrderEvidenceEventDTO) {
  const refs = event.refs;
  if (!refs) return null;
  const items: { label: string; value: string }[] = [];
  if (refs.paymentSessionId)
    items.push({ label: "Session id", value: refs.paymentSessionId });
  if (refs.paymentIntentId)
    items.push({ label: "Intent id", value: refs.paymentIntentId });
  if (refs.gatewayEventId)
    items.push({ label: "Gateway event", value: refs.gatewayEventId });
  if (refs.messageId)
    items.push({ label: "Message id", value: refs.messageId });
  if (refs.signatureName)
    items.push({ label: "Signature", value: refs.signatureName });
  if (refs.consentTokenHash)
    items.push({ label: "Token hash", value: refs.consentTokenHash });
  if (items.length === 0) return null;
  return (
    <View>
      {items.map((i) => (
        <Row key={i.label} label={i.label} value={i.value} />
      ))}
    </View>
  );
}

function ConsentBlock({ events }: { events: OrderEvidenceEventDTO[] }) {
  const received = findLast(events, "CONSENT_RECEIVED");
  if (!received) {
    return (
      <Text style={{ color: "#94a3b8" }}>
        Customer has not confirmed consent.
      </Text>
    );
  }
  const verified = findLast(events, "CONSENT_VERIFIED");
  return (
    <View>
      <Row
        label="Status"
        value={verified ? "VERIFIED" : "RECEIVED"}
      />
      <Row label="Signed name" value={asString(received.payload.signedName)} />
      <Row label="Statement" value={asString(received.payload.consentMessage)} />
      <Row
        label="Acknowledgement"
        value={asString(received.payload.acknowledgement)}
      />
      <Row label="Method" value={asString(received.payload.method)} />
      <Row label="Received at" value={received.occurredAt} />
      <Row label="IP" value={formatIp(received.request?.ip)} />
      <Row label="User agent" value={received.request?.userAgent ?? "—"} />
      <Row
        label="Token hash"
        value={received.refs?.consentTokenHash ?? "—"}
      />
      <Row label="Payload hash" value={received.snapshotHash} />
    </View>
  );
}

function PaymentBlock({ events }: { events: OrderEvidenceEventDTO[] }) {
  const paid = findLast(events, "PAYMENT_COMPLETED");
  if (!paid) {
    return (
      <Text style={{ color: "#94a3b8" }}>
        No completed payment recorded.
      </Text>
    );
  }
  return (
    <View>
      <Row label="Gateway" value={asString(paid.payload.gateway) || "—"} />
      <Row
        label="Session id"
        value={asString(paid.payload.paymentSessionId) || "—"}
      />
      <Row
        label="Intent / transaction id"
        value={asString(paid.payload.paymentIntentId) || "—"}
      />
      <Row
        label="Gateway event id"
        value={asString(paid.payload.gatewayEventId) || "—"}
      />
      <Row
        label="Amount received"
        value={String(paid.payload.amountReceived ?? "—")}
      />
      <Row label="Currency" value={asString(paid.payload.currency) || "—"} />
      <Row label="Paid at" value={asString(paid.payload.paidAt) || "—"} />
      <Row label="Source" value={asString(paid.payload.source) || "—"} />
    </View>
  );
}

function EmailBlock({ events }: { events: OrderEvidenceEventDTO[] }) {
  const emails = events.filter(
    (e) =>
      e.eventType === "PAYMENT_REQUEST_EMAIL_SENT" ||
      e.eventType === "CONFIRMATION_EMAIL_SENT",
  );
  if (emails.length === 0) {
    return (
      <Text style={{ color: "#94a3b8" }}>No emails sent yet.</Text>
    );
  }
  return (
    <View>
      {emails.map((email) => {
        // We render the plain-text version of the email (already captured
        // alongside the HTML at send time) so the dispute packet is one
        // self-contained document. The HTML stays in the chain payload
        // for the on-page viewer; embedding it here would require an
        // HTML→PDF bridge and balloon the file with base64 images.
        const text = asString(email.payload.text);
        const body =
          text.length > 0
            ? text
            : "(plain-text version not captured for this send)";
        return (
          <View key={email.id} style={styles.card}>
            <View style={styles.eventHeader}>
              <Text style={styles.eventTitle}>
                {OrderEvidenceEventLabel[email.eventType] ?? email.eventType}
              </Text>
              <Text>{email.occurredAt}</Text>
            </View>
            <Row label="Subject" value={asString(email.payload.subject)} />
            <Row label="To" value={asString(email.payload.to)} />
            <Row label="From" value={asString(email.payload.from)} />
            {asString(email.payload.replyTo) ? (
              <Row
                label="Reply-To"
                value={asString(email.payload.replyTo)}
              />
            ) : null}
            <Row
              label="Message id"
              value={asString(email.payload.messageId) || "—"}
            />
            <Row label="Snapshot hash" value={email.snapshotHash} />
            <View style={styles.divider} />
            <Text
              style={{
                fontFamily: "Courier",
                fontSize: 8,
                color: "#1e293b",
                lineHeight: 1.4,
              }}
            >
              {body}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function findLast<T extends OrderEvidenceEventDTO>(
  events: T[],
  type: T["eventType"],
): T | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].eventType === type) return events[i];
  }
  return null;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}
