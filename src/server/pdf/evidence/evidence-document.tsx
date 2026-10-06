import "server-only";

import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

import { flightAmountLabels } from "@/lib/charges";
import {
  OrderEvidenceActorLabel,
  OrderEvidenceEventLabel,
  providerLabelFor,
  ServiceItemLabel,
  ServiceTypeLabel,
} from "@/lib/constants/labels";
import { FlightTripType, ServiceType } from "@/lib/constants/enums";
import {
  type FlightJourneyView,
  type FlightLayoverView,
  type FlightSegmentView,
  formatDuration,
  formatLocalDate,
  formatSegmentTime,
  journeyStopsLabel,
  type LocalDateTime,
  segmentCarrier,
} from "@/lib/flight-itinerary";
import { formatCurrency, formatIp } from "@/lib/format";
import type {
  EvidenceFlightDTO,
  OrderEvidenceChainWithFlightDTO,
} from "@/server/services/evidence.service";
import type { OrderEvidenceEventDTO } from "@/types";

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
  note: { fontSize: 8, color: "#64748b", marginTop: 4, marginBottom: 6 },
  journeyTitle: {
    fontSize: 9,
    fontWeight: 700,
    color: "#475569",
    marginTop: 4,
    marginBottom: 4,
  },
  layover: {
    borderColor: "#cbd5e1",
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 4,
    backgroundColor: "#f8fafc",
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 6,
  },
  layoverNotes: { fontSize: 8, color: "#64748b", marginTop: 2 },
});

interface EvidenceDocumentProps {
  chain: OrderEvidenceChainWithFlightDTO;
  generatedAt: Date;
}

/**
 * The PDF draws with the built-in Helvetica / Courier, which only carry the
 * WinAnsi character set: "→" prints as "’" and "⏱" as "ñ". Flight copy —
 * routes, segment titles, captured flight emails — leans on both, so swap
 * them for characters these fonts can draw. Display only (the hashed
 * payloads are untouched), and applied to flight packets alone, so a car
 * rental's packet is byte-for-byte what it was.
 */
function pdfSafe(text: string): string {
  return text.replace(/⏱️?\s?/g, "").replace(/→/g, "->");
}

export function EvidenceDocument({
  chain,
  generatedAt,
}: EvidenceDocumentProps) {
  const { order, events, verification } = chain;
  // A snapshot taken before `serviceType` existed has no such field, and
  // every order that predates it is a car rental.
  const serviceType = order.serviceType ?? ServiceType.CAR_RENTAL;
  const isCarRental = serviceType === ServiceType.CAR_RENTAL;
  // `vehicle` is null on a flight or hotel; `item` carries the equivalent
  // ("LHR → JFK", "Hilton • Paris"). Never drop the line — this is the
  // packet a chargeback is defended with.
  const vehicle = order.vehicle;
  const isFlight = serviceType === ServiceType.FLIGHT;
  // FLIGHT only (see `getEvidenceChain`): the itinerary and money split.
  const flight = chain.flight ?? null;
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
        {flight ? (
          <FlightAmountRows
            flight={flight}
            currency={order.pricing.currency}
          />
        ) : (
          <Row
            label="Amount"
            value={formatCurrency(order.pricing.amount, order.pricing.currency)}
          />
        )}
        <Row
          label={providerLabelFor(serviceType, "Provider")}
          value={order.provider?.name ?? "—"}
        />
        {isCarRental ? null : (
          <Row label="Service" value={ServiceTypeLabel[serviceType]} />
        )}
        {vehicle ? (
          <Row
            label="Vehicle"
            value={`${vehicle.company} · ${vehicle.type}`}
          />
        ) : (
          <Row
            label={ServiceItemLabel[serviceType]}
            value={isFlight ? pdfSafe(order.item) : order.item}
          />
        )}
        <Row label="Created" value={order.createdAt} />

        <View style={styles.imagesRow}>
          {order.provider?.logo ? (
            <View style={styles.imageTile}>
              <Text style={styles.imageTileLabel}>
                {providerLabelFor(serviceType, "Provider")}
              </Text>
              <Image
                src={order.provider.logo}
                style={styles.imageTileImg}
              />
              <Text style={styles.imageTileCaption}>{order.provider.name}</Text>
            </View>
          ) : null}
          {vehicle?.imageUrl ? (
            <View style={styles.imageTile}>
              <Text style={styles.imageTileLabel}>Vehicle</Text>
              <Image
                src={vehicle.imageUrl}
                style={styles.imageTileImg}
              />
              <Text style={styles.imageTileCaption}>
                {vehicle.company} · {vehicle.type}
              </Text>
            </View>
          ) : null}
        </View>

        {flight ? <FlightBlock flight={flight} /> : null}

        <Text style={styles.h2}>Consent evidence</Text>
        <ConsentBlock events={events} />

        <Text style={styles.h2}>Payment evidence</Text>
        <PaymentBlock events={events} />

        <Text style={styles.h2}>Email evidence</Text>
        <EmailBlock
          events={events}
          display={isFlight ? pdfSafe : (text) => text}
        />

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

function EmailBlock({
  events,
  display,
}: {
  events: OrderEvidenceEventDTO[];
  /** Applied to the captured subject and body before they are drawn —
   *  `pdfSafe` on a flight packet, identity otherwise. */
  display: (text: string) => string;
}) {
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
        const text = display(asString(email.payload.text));
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
            <Row
              label="Subject"
              value={display(asString(email.payload.subject))}
            />
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

/**
 * The money split that stands in for the single "Amount" row on a flight.
 * The payment link only ever collects `pricing.amount` — on an itinerary
 * flight, the service charge; the airline fare is part of the booking value
 * but was never charged here — the distinction a flight chargeback turns on.
 * A flight created before itineraries is labelled neutrally: its charge
 * lines were usually the whole fare.
 */
function FlightAmountRows({
  flight,
  currency,
}: {
  flight: EvidenceFlightDTO;
  currency: string;
}) {
  const { amounts, collection } = flight;
  const labels = flightAmountLabels(flight.serviceChargeModel);
  return (
    <View>
      {amounts.airlineFare > 0 ? (
        <Row
          label={labels.airlineFare}
          value={`${formatCurrency(amounts.airlineFare, currency)} — not collected by the payment link`}
        />
      ) : null}
      <Row
        label={labels.serviceCharge}
        value={formatCurrency(amounts.serviceCharge, currency)}
      />
      {amounts.dueLater > 0 ? (
        <Row
          label={labels.dueLater}
          value={formatCurrency(amounts.dueLater, currency)}
        />
      ) : null}
      <Row
        label={labels.bookingTotal}
        value={formatCurrency(amounts.bookingTotal, currency)}
      />
      <Row
        label={labels.collectedOnline}
        value={
          collection.status === "COLLECTED" && collection.amount !== null
            ? formatCurrency(collection.amount, currency)
            : collection.status === "ON_HOLD"
              ? labels.onHoldNotCollected
              : labels.notCollected
        }
      />
    </View>
  );
}

/**
 * The itinerary a flight dispute is about, as the operator recorded it:
 * the trip-level rows, then every journey with its numbered flights and
 * the layovers between them. The web page draws the same view with
 * `FlightItinerary`; this is that view in react-pdf primitives.
 */
// Fragments rather than wrapping Views from here down: react-pdf only
// honours `minPresenceAhead` for an element with earlier siblings in the
// same container, so the journey headings must sit beside what precedes
// them.
function FlightBlock({ flight }: { flight: EvidenceFlightDTO }) {
  const { itinerary } = flight;
  return (
    <>
      <Text style={styles.h2}>Flight itinerary</Text>
      {flight.details.map((row) => (
        <Row key={row.label} label={row.label} value={pdfSafe(row.value)} />
      ))}
      {flight.passengerNotes ? (
        <Row label="Passenger notes" value={pdfSafe(flight.passengerNotes)} />
      ) : null}
      {itinerary ? (
        <>
          <Text style={styles.note}>
            {itinerary.legacy
              ? "Booked before itineraries existed — times are in UTC."
              : "Times are local to each airport."}
          </Text>
          {itinerary.journeys.map((journey) => (
            <FlightJourney
              key={journey.key}
              journey={journey}
              tripType={itinerary.tripType}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function FlightJourney({
  journey,
  tripType,
}: {
  journey: FlightJourneyView;
  tripType: FlightTripType;
}) {
  // "Direct" / "2 stops" — or "3 flights" on a multi-city trip, whose legs
  // are destinations in their own right, not stops.
  const shape = journeyStopsLabel(journey, tripType);
  return (
    <>
      {/* Keeps a journey heading from being stranded at the foot of a
          page, apart from its first flight. */}
      <Text style={styles.journeyTitle} minPresenceAhead={100}>
        {pdfSafe(
          `${journey.label.toUpperCase()} · ${journey.route} · ${shape}`,
        )}
      </Text>
      {journey.segments.map((segment, index) => {
        const layover = journey.connections[index]?.layover ?? null;
        return (
          <View key={segment.number}>
            <FlightSegment
              segment={segment}
              timeZoneLabel={journey.timeZoneLabel}
            />
            {layover ? <FlightLayover layover={layover} /> : null}
          </View>
        );
      })}
    </>
  );
}

function FlightSegment({
  segment,
  timeZoneLabel,
}: {
  segment: FlightSegmentView;
  timeZoneLabel: string | null;
}) {
  const carrier = segmentCarrier(segment);
  // Airport-local wall clock, printed as entered ("UTC" only on a legacy
  // order). "—" where the order never recorded the time.
  const at = (value: LocalDateTime | null) =>
    value
      ? `${formatLocalDate(value.date)} · ${formatSegmentTime(value, timeZoneLabel)}`
      : "—";
  return (
    <View style={styles.card} wrap={false}>
      <Text style={styles.eventTitle}>
        {pdfSafe(
          `Flight ${segment.number} · ${segment.origin} → ${segment.destination}`,
        )}
      </Text>
      {carrier ? <Row label="Airline" value={pdfSafe(carrier)} /> : null}
      <Row label="Departs" value={at(segment.departure)} />
      <Row label="Arrives" value={at(segment.arrival)} />
      {segment.details ? (
        <Row label="Details" value={pdfSafe(segment.details)} />
      ) : null}
    </View>
  );
}

function FlightLayover({ layover }: { layover: FlightLayoverView }) {
  // Same wording as the web itinerary, operator hint included: this packet
  // is read by the dispute team, not the customer.
  const headline = `${
    layover.minutes !== null
      ? `Layover: ${formatDuration(layover.minutes)}`
      : "Layover"
  }${layover.location ? ` — ${layover.location}` : ""}`;
  const adjusted =
    layover.overrideMinutes === null
      ? ""
      : layover.calculatedMinutes !== null && layover.calculatedMinutes >= 0
        ? ` (adjusted; flight times give ${formatDuration(layover.calculatedMinutes)})`
        : " (adjusted)";
  return (
    <View style={styles.layover} wrap={false}>
      <Text>{pdfSafe(`${headline}${adjusted}`)}</Text>
      {layover.notes ? (
        <Text style={styles.layoverNotes}>{pdfSafe(layover.notes)}</Text>
      ) : null}
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
