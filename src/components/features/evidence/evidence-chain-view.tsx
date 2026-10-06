"use client";

import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FlightItinerary } from "@/components/common/flight-itinerary";
import { PageHeader } from "@/components/common/page-header";
import { flightAmountLabels } from "@/lib/charges";
import {
  providerLabelFor,
  ServiceItemLabel,
  ServiceTypeLabel,
} from "@/lib/constants/labels";
import { ServiceType } from "@/lib/constants/enums";
import { formatCurrency, formatDateTime } from "@/lib/format";
import type {
  EvidenceFlightDTO,
  OrderEvidenceChainWithFlightDTO,
} from "@/server/services/evidence.service";

import { ConsentEvidenceCard } from "./consent-evidence-card";
import { EvidenceTimeline } from "./evidence-timeline";
import { IntegrityBadge } from "./integrity-badge";

interface EvidenceChainViewProps {
  chain: OrderEvidenceChainWithFlightDTO;
  canExport: boolean;
}

/**
 * Read-only dispute-defense screen. Renders the full hash-chained
 * timeline, a consent evidence card, and the integrity status of the
 * chain.
 *
 * "Download PDF" hits the server-rendered export route
 * (`/orders/[id]/evidence/export`) which streams an
 * `application/pdf` packet. Server-side rendering is gated by an
 * in-process semaphore (one render at a time) and a hard cap on
 * chain length so a single export can't OOM the $5-tier box — the
 * UI surfaces a Retry-After on 503.
 *
 * The previous `window.print()` UX is gone; print-time CSS classes
 * are kept as belt-and-suspenders for ad-hoc browser prints but the
 * canonical PDF is now the server export.
 */
export function EvidenceChainView({
  chain,
  canExport,
}: EvidenceChainViewProps) {
  const { events, verification, order } = chain;
  // A snapshot taken before `serviceType` existed has no such field, and
  // every order that predates it is a car rental.
  const serviceType = order.serviceType ?? ServiceType.CAR_RENTAL;
  const isCarRental = serviceType === ServiceType.CAR_RENTAL;
  // Null on a flight or hotel — there is no car. `order.item` carries the
  // service-agnostic equivalent ("LHR → JFK", "Hilton • Paris"), so the
  // header never loses the "what was bought" line.
  const vehicle = order.vehicle;
  // FLIGHT only (see `getEvidenceChain`): the itinerary and money split.
  const flight = chain.flight ?? null;
  // Authed app surfaces live under `/app/*` (the route folder is `app`,
  // not the `(app)` route-group that would have been URL-transparent).
  // Anchor + back-to-order link must carry the same prefix or every
  // click 404s.
  const exportHref = `/app/orders/${order.id}/evidence/export`;
  return (
    <div className="space-y-6 print:space-y-4">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="w-fit print:hidden"
      >
        <Link href={`/app/orders/${order.id}`}>
          <ArrowLeftIcon className="size-3.5" />
          Back to order
        </Link>
      </Button>
      <PageHeader
        eyebrow="Dispute evidence"
        title={`${order.orderNumber} — evidence chain`}
        description="Immutable, hash-chained record of this order's full lifecycle. Use this as the single document a dispute / chargeback can be defended with."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <IntegrityBadge verification={verification} />
            {canExport ? (
              <Button asChild size="sm" title="Download server-rendered PDF">
                <a
                  href={exportHref}
                  download={`evidence-${order.orderNumber}.pdf`}
                >
                  <DownloadIcon className="size-3.5" />
                  Download PDF
                </a>
              </Button>
            ) : null}
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order header</CardTitle>
          <CardDescription>
            Snapshot of the order at the moment this page was loaded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 text-[12.5px] sm:grid-cols-2">
            <Row label="Order number" value={order.orderNumber} mono />
            <Row label="Status" value={order.status} />
            <Row label="Customer" value={order.customer.name} />
            <Row label="Customer email" value={order.customer.email} />
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
              label="Created"
              value={formatDateTime(order.createdAt)}
            />
            <Row label="Events recorded" value={String(events.length)} />
            {isCarRental ? null : (
              <Row label="Service" value={ServiceTypeLabel[serviceType]} />
            )}
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[12.5px] font-semibold text-foreground">
              {providerLabelFor(serviceType, "Provider")}
            </h4>
            <div className="flex items-center gap-2 text-[13px]">
              {order.provider?.logo ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={order.provider.logo}
                  alt={
                    order.provider?.name
                      ? `${order.provider.name} logo`
                      : "Provider logo"
                  }
                  className="h-9 w-auto object-contain"
                />
              ) : null}
              <span>{order.provider?.name ?? "—"}</span>
            </div>
          </div>

          {vehicle ? (
            <>
              <div className="space-y-1">
                <h4 className="text-[12.5px] font-semibold text-foreground">
                  Car make
                </h4>
                <p className="text-[13px]">{vehicle.company}</p>
              </div>

              <div className="space-y-1">
                <h4 className="text-[12.5px] font-semibold text-foreground">
                  Car model
                </h4>
                <p className="text-[13px]">{vehicle.type}</p>
              </div>

              {vehicle.imageUrl ? (
                <div className="space-y-1.5">
                  <h4 className="text-[12.5px] font-semibold text-foreground">
                    Car image
                  </h4>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={vehicle.imageUrl}
                    alt={`${vehicle.company} ${vehicle.type}`}
                    className="max-h-64 w-auto rounded-md border border-border object-cover"
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="space-y-1">
              <h4 className="text-[12.5px] font-semibold text-foreground">
                {ServiceItemLabel[serviceType]}
              </h4>
              <p className="text-[13px]">{order.item}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {flight ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Flight itinerary</CardTitle>
            <CardDescription>
              {flight.itinerary?.legacy
                ? "Every flight on this order. Booked before itineraries existed — times are shown in UTC."
                : "Every flight and layover on this order. Times are local to each airport."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {flight.details.length > 0 ? (
              <div className="grid gap-3 text-[12.5px] sm:grid-cols-2">
                {flight.details.map((row) => (
                  <Row key={row.label} label={row.label} value={row.value} />
                ))}
              </div>
            ) : null}
            {flight.itinerary ? (
              <FlightItinerary itinerary={flight.itinerary} showOverrideHint />
            ) : null}
            {flight.passengerNotes ? (
              <div className="space-y-1">
                <h4 className="text-[12.5px] font-semibold text-foreground">
                  Passenger notes
                </h4>
                <p className="whitespace-pre-line text-[13px]">
                  {flight.passengerNotes}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <ConsentEvidenceCard events={events} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event chain</CardTitle>
          <CardDescription>
            Each event is hashed against the previous one. Editing a single
            payload field cascades into every downstream hash and surfaces
            here as a red &ldquo;broken&rdquo; indicator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">
              No evidence events recorded for this order yet. Events appear
              automatically when an order is created, a payment link is
              generated, an email is sent, consent is received, or a webhook
              confirms payment.
            </p>
          ) : (
            <EvidenceTimeline
              events={events}
              brokenAtSequence={verification.brokenAtSequence}
              serviceType={serviceType}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A flight's money split in place of the single "Amount" row. The payment
 * link only ever collects `pricing.amount` — on an itinerary flight, the
 * service charge; the airline fare is part of the booking value but was
 * never charged here — the distinction a flight chargeback turns on. A
 * flight created before itineraries is labelled neutrally: its charge lines
 * were usually the whole fare.
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
    <>
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
    </>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-x-3">
      <div className="text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono" : ""}>{value}</div>
    </div>
  );
}

