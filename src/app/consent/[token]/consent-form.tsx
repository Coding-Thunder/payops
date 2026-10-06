"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheckIcon } from "lucide-react";

import { api, ApiClientError } from "@/lib/api-client";
import { FlightItinerary } from "@/components/common/flight-itinerary";
import { Checkbox } from "@/components/ui/checkbox";
import { flightMoneyWording, LEGACY_FLIGHT_AMOUNT_LABELS } from "@/lib/charges";
import { ServiceType } from "@/lib/constants/enums";
import {
  BookingTypeLabel,
  FLIGHT_PROVIDER_LABEL,
} from "@/lib/constants/labels";
import {
  buildFlightItinerary,
  type FlightItineraryView,
} from "@/lib/flight-itinerary";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { serviceDetailRows } from "@/lib/service-summary";
import type { BrandingDTO, PublicConsentView } from "@/types";

interface ConsentFormProps {
  token: string;
  initialView: PublicConsentView;
  branding: BrandingDTO;
}

/**
 * Hosted consent → gateway checkout handoff.
 *
 * The page has one job: capture a digital signature and push the customer
 * into the gateway's hosted checkout (Stripe or PayPal, named from
 * `view.gatewayLabel`). There's no intermediate "you're confirmed" screen
 * because the spec demands an immediate handoff — any dead state between
 * sign and pay erodes conversion.
 *
 * Three runtime states:
 *  1. fresh REQUESTED — render the form (booking summary + required
 *     signature + confirm button).
 *  2. submitting       — disabled CTA + inline spinner copy.
 *  3. redirecting      — page replaces itself to the checkout URL via
 *     `window.location.replace`. We render a slim "Redirecting…" shell
 *     so the brief window before the browser navigates isn't blank. If
 *     the redirect hasn't completed after 5 s (mobile browser quirk,
 *     popup blocker, broken network) we surface a manual fallback link.
 *
 * The same `redirecting` state is entered on mount when the record is
 * already RECEIVED — i.e. the customer refreshed after consenting. They
 * never see the form again; they go straight to checkout.
 */

const REDIRECT_FALLBACK_MS = 5_000;

export function ConsentForm({ token, initialView, branding }: ConsentFormProps) {
  const [view, setView] = useState<PublicConsentView>(initialView);
  const [signature, setSignature] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const fallbackTimer = useRef<number | null>(null);

  /** Imperative redirect with safety net. Browsers handle
   *  `location.replace` asynchronously; on mobile the navigation can
   *  occasionally stall (background tab, low-power mode). A 5 s timer
   *  surfaces a manual link in that case so the customer is never
   *  stranded on a "loading…" screen. */
  const startRedirect = useCallback((url: string) => {
    setRedirecting(true);
    setError(null);
    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    fallbackTimer.current = window.setTimeout(() => {
      setFallbackUrl(url);
    }, REDIRECT_FALLBACK_MS);
    try {
      window.location.replace(url);
    } catch {
      // Synchronous throw is exotic but possible (sandboxed iframes,
      // ancient browsers). Reveal the manual CTA immediately.
      setFallbackUrl(url);
    }
  }, []);

  // Refresh-after-consent path: if the record already shows RECEIVED
  // and we have a checkout URL, redirect immediately. No form, no
  // "you're confirmed" intermediate state.
  useEffect(() => {
    if (!view.alreadyConfirmedAt) return;
    if (!view.paymentUrl) return;
    startRedirect(view.paymentUrl);
  }, [view.alreadyConfirmedAt, view.paymentUrl, startRedirect]);

  useEffect(() => {
    return () => {
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    };
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || redirecting) return;

    const trimmed = signature.trim();
    if (trimmed.length < 2) {
      setError("Please type your full name as your digital signature.");
      return;
    }
    if (!agreed) {
      setError("Please tick the acknowledgement to confirm.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const next = await api.post<PublicConsentView>(`/api/consent/${token}`, {
        acknowledgement: view.consentMessage,
        signedName: trimmed,
      });
      setView(next);
      if (next.paymentUrl) {
        startRedirect(next.paymentUrl);
      } else {
        // No checkout URL on record — rare, but surface it cleanly rather
        // than silently leaving the customer on a finished form.
        setError(
          "Your acknowledgement was recorded, but no payment link is currently available. Please contact support.",
        );
        setSubmitting(false);
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not save your confirmation. Please try again.",
      );
      setSubmitting(false);
    }
  }

  if (redirecting) {
    return (
      <RedirectingShell
        fallbackUrl={fallbackUrl}
        branding={branding}
        gatewayLabel={view.gatewayLabel}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-gradient-to-br from-slate-50 via-white to-white px-6 pt-8 pb-6 sm:px-8 sm:pt-10">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <ShieldCheckIcon className="size-3.5" aria-hidden />
          Confirm your booking
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
          Hi {view.customerName.split(" ")[0]},
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Review the details below, sign with your full name, and you&apos;ll
          continue to {view.brandName}
          {view.gatewayLabel
            ? `'s secure ${view.gatewayLabel} checkout.`
            : "'s secure checkout."}
        </p>
      </div>

      <SummaryBlock view={view} />

      <form
        onSubmit={onSubmit}
        className="space-y-5 border-t border-slate-100 px-6 py-6 sm:px-8"
        noValidate
      >
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
            Acknowledgement
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-800">
            {view.consentMessage}
          </p>
        </div>

        <div>
          <label
            htmlFor="signedName"
            className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500"
          >
            Digital signature <span className="text-rose-600">*</span>
          </label>
          <input
            id="signedName"
            type="text"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder={view.customerName}
            autoComplete="name"
            required
            aria-required="true"
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-900"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Type your full name. This is your signed acknowledgement and is
            stored as proof against this booking.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 transition hover:bg-slate-50">
          <Checkbox
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
            className="mt-0.5"
          />
          <span className="text-sm leading-relaxed text-slate-700">
            I confirm I have reviewed these details and agree to proceed.
          </span>
        </label>

        {error ? (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || redirecting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? (
            <>
              <Spinner />
              Confirming…
            </>
          ) : (
            "Confirm & Continue to Payment"
          )}
        </button>

        <p className="text-center text-[11px] text-slate-500">
          {`You'll be taken directly to ${checkoutName(view.gatewayLabel)} to complete payment. Your timestamp and IP are recorded against this booking as evidence of consent.`}
          {/* A brand that publishes no support address gets no dead link. */}
          {branding.supportEmail ? (
            <>
              {" "}
              <a
                href={`mailto:${branding.supportEmail}`}
                className="text-slate-600 underline-offset-2 hover:underline"
              >
                Email {branding.supportEmail}
              </a>{" "}
              if you need help.
            </>
          ) : null}
        </p>
      </form>
    </div>
  );
}

function SummaryBlock({ view }: { view: PublicConsentView }) {
  const { snapshot } = view;
  // Consent records written before `serviceType` existed are car rentals.
  const serviceType = snapshot.serviceType ?? ServiceType.CAR_RENTAL;
  // A flight request freezes its whole itinerary. One written before that
  // existed has only the folded rows below, and renders exactly as before.
  const itinerary =
    serviceType === ServiceType.FLIGHT && snapshot.flight
      ? buildFlightItinerary(snapshot.flight)
      : null;
  if (itinerary) {
    return <FlightSummaryBlock view={view} itinerary={itinerary} />;
  }
  const currency = snapshot.currency;
  const dueAtCounter = snapshot.dueAtCounter ?? 0;
  const total = snapshot.total ?? snapshot.amount;
  const hasCounterDue = dueAtCounter > 0;
  const wording = CONSENT_WORDING[serviceType];
  return (
    <div className="border-t border-slate-100 px-6 py-5 sm:px-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
        Booking summary
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            You are paying today
          </p>
          <span className="text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
            {formatCurrency(snapshot.amount, currency)}
          </span>
        </div>
        <span className="text-xs text-slate-500">
          {BookingTypeLabel[snapshot.bookingType]}
        </span>
      </div>

      {hasCounterDue ? (
        <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Paid online today</span>
            <span className="tabular-nums text-slate-900">
              {formatCurrency(snapshot.amount, currency)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">{wording.dueLabel}</span>
            <span className="tabular-nums text-slate-900">
              {formatCurrency(dueAtCounter, currency)}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 font-medium">
            <span className="text-slate-700">{wording.totalLabel}</span>
            <span className="tabular-nums text-slate-900">
              {formatCurrency(total, currency)}
            </span>
          </div>
        </div>
      ) : null}

      <dl className="mt-4 divide-y divide-slate-100 text-sm">
        <DetailRow label="Customer" value={view.customerName} />
        <DetailRow label="Email" value={view.customerEmail} mono />
        <DetailRow
          label={wording.providerLabel}
          value={snapshot.provider || "—"}
        />
        <DetailRow label={wording.itemLabel} value={snapshot.vehicle} />
        <DetailRow
          label={wording.startLabel}
          value={
            snapshot.pickupLocation
              ? `${formatDateTime(snapshot.pickupDate)} · ${snapshot.pickupLocation}`
              : formatDateTime(snapshot.pickupDate)
          }
        />
        {/* A one-way flight stores the departure date in BOTH slots (the
            consent chain is one shape); showing "Return" with the outbound
            date would be a lie, so it is omitted. */}
        {wording.endLabel &&
        !(
          serviceType === ServiceType.FLIGHT &&
          snapshot.dropoffDate === snapshot.pickupDate
        ) ? (
          <DetailRow
            label={wording.endLabel}
            value={
              snapshot.dropoffLocation
                ? `${formatDateTime(snapshot.dropoffDate)} · ${snapshot.dropoffLocation}`
                : formatDateTime(snapshot.dropoffDate)
            }
          />
        ) : null}
      </dl>
    </div>
  );
}

/**
 * A flight's booking summary: what this payment covers (the service charge)
 * set against the full booking value, then the trip and every flight and
 * layover. The money block is shown for every flight — not gated on a
 * counter balance like a rental's — because its job is to make clear that
 * the airline fare is not part of this payment.
 *
 * Worded from the FROZEN itinerary: a record whose `snapshot.flight` has an
 * outbound journey is the service-charge model; one frozen from a flight
 * created before itineraries (flat fields only) usually paid its whole fare
 * here, so its labels are neutral and the "service charge" line is left out.
 */
function FlightSummaryBlock({
  view,
  itinerary,
}: {
  view: PublicConsentView;
  itinerary: FlightItineraryView;
}) {
  const { snapshot } = view;
  const { labels, serviceChargeModel } = flightMoneyWording(snapshot.flight, snapshot.bookingType);
  const currency = snapshot.currency;
  const airlineFare = snapshot.airlineFare ?? 0;
  // Non-zero only for a flight created before flights became prepaid-only.
  const dueLater = snapshot.dueAtCounter ?? 0;
  const bookingTotal =
    snapshot.bookingTotal ?? airlineFare + snapshot.amount + dueLater;
  return (
    <>
      <div className="border-t border-slate-100 px-6 py-5 sm:px-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
          Booking summary
        </p>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {labels.payableNow}
            </p>
            <span className="text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
              {formatCurrency(snapshot.amount, currency)}
            </span>
            {serviceChargeModel ? (
              <p className="text-xs text-slate-500">{labels.serviceCharge}</p>
            ) : null}
          </div>
          <span className="text-xs text-slate-500">
            {BookingTypeLabel[snapshot.bookingType]}
          </span>
        </div>

        <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50/60 px-4 py-3 text-sm">
          {airlineFare > 0 ? (
            <div className="flex items-start justify-between gap-3">
              <span className="text-slate-500">
                {labels.airlineFare}
                <span className="block text-[11px] text-slate-400">
                  {labels.airlineFareNote}
                </span>
              </span>
              <span className="tabular-nums text-slate-900">
                {formatCurrency(airlineFare, currency)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">{labels.serviceCharge}</span>
            <span className="tabular-nums text-slate-900">
              {formatCurrency(snapshot.amount, currency)}
            </span>
          </div>
          {dueLater > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">{labels.dueLater}</span>
              <span className="tabular-nums text-slate-900">
                {formatCurrency(dueLater, currency)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-1.5 font-medium">
            <span className="text-slate-700">{labels.bookingTotal}</span>
            <span className="tabular-nums text-slate-900">
              {formatCurrency(bookingTotal, currency)}
            </span>
          </div>
        </div>

        <dl className="mt-4 divide-y divide-slate-100 text-sm">
          <DetailRow label="Customer" value={view.customerName} />
          <DetailRow label="Email" value={view.customerEmail} mono />
          <DetailRow
            label={CONSENT_WORDING.FLIGHT.providerLabel}
            value={snapshot.provider || "—"}
          />
          {serviceDetailRows({
            serviceType: ServiceType.FLIGHT,
            flight: snapshot.flight,
          }).map((row) => (
            <DetailRow key={row.label} label={row.label} value={row.value} />
          ))}
        </dl>
      </div>

      <div className="border-t border-slate-100 px-6 py-5 sm:px-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
          Itinerary
        </p>
        <FlightItinerary itinerary={itinerary} className="mt-3" />
      </div>
    </>
  );
}

/**
 * Name of the hosted checkout the customer is sent to. Neutral when the
 * record names no gateway: telling a PayPal brand's customer they are off
 * to "Stripe Checkout" is the phishing tell this replaced.
 */
function checkoutName(gatewayLabel: string | null | undefined): string {
  return gatewayLabel ? `${gatewayLabel} Checkout` : "our secure checkout";
}

function RedirectingShell({
  fallbackUrl,
  branding,
  gatewayLabel,
}: {
  fallbackUrl: string | null;
  branding: BrandingDTO;
  gatewayLabel: string | null;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center px-6 py-12 text-center sm:px-8">
        <Spinner large />
        <h1 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">
          Opening secure payment…
        </h1>
        <p className="mt-1.5 max-w-md text-sm text-slate-600">
          {`We've recorded your acknowledgement. You're being taken straight to ${checkoutName(gatewayLabel)} to complete payment.`}
        </p>
        {fallbackUrl ? (
          <div className="mt-6 w-full max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left">
            <p className="text-xs font-medium text-amber-900">
              Redirect failed.
            </p>
            <p className="mt-1 text-[11px] text-amber-800">
              {`Your browser didn't open ${gatewayLabel ?? "the payment page"} automatically. Continue securely below.`}
            </p>
            <a
              href={fallbackUrl}
              className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Continue to secure payment →
            </a>
          </div>
        ) : null}
        {branding.supportEmail ? (
          <p className="mt-6 text-[11px] text-slate-500">
            Trouble?{" "}
            <a
              href={`mailto:${branding.supportEmail}`}
              className="font-medium text-slate-700 underline-offset-2 hover:underline"
            >
              Email {branding.supportEmail}
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Spinner({ large = false }: { large?: boolean }) {
  const size = large ? "size-8" : "size-4";
  return (
    <span
      aria-hidden
      className={`inline-block ${size} animate-spin rounded-full border-2 border-slate-300 border-t-slate-900`}
    />
  );
}

/**
 * Row labels and charge-breakdown copy, per service type.
 *
 * The consent snapshot's base is deliberately ONE shape — an item plus a
 * start and an end date — so the append-only consent chain never forks. For
 * a record without a frozen itinerary (every one written before flights
 * carried it), these labels are the only thing standing between a flight
 * passenger and a page asking them to confirm a "Vehicle" and a "Drop-off"
 * before they pay. Such a record is a flight frozen before itineraries, so
 * its money labels are the neutral `LEGACY_FLIGHT_AMOUNT_LABELS` — the copy
 * source the receipt page and the emails share.
 *
 * CAR_RENTAL reproduces the exact strings this page has always rendered.
 */
const CONSENT_WORDING: Record<
  ServiceType,
  {
    providerLabel: string;
    itemLabel: string;
    startLabel: string;
    endLabel: string | null;
    dueLabel: string;
    totalLabel: string;
  }
> = {
  CAR_RENTAL: {
    providerLabel: "Provider",
    itemLabel: "Vehicle",
    startLabel: "Pick-up",
    endLabel: "Drop-off",
    dueLabel: "Remaining balance due at rental counter",
    totalLabel: "Total rental cost",
  },
  FLIGHT: {
    providerLabel: FLIGHT_PROVIDER_LABEL,
    itemLabel: "Route",
    startLabel: "Departure",
    endLabel: "Return",
    dueLabel: LEGACY_FLIGHT_AMOUNT_LABELS.dueLater,
    totalLabel: LEGACY_FLIGHT_AMOUNT_LABELS.bookingTotal,
  },
  HOTEL: {
    providerLabel: "Provider",
    itemLabel: "Property",
    startLabel: "Check-in",
    endLabel: "Check-out",
    dueLabel: "Remaining balance due at the property",
    totalLabel: "Total stay cost",
  },
};

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={
          mono
            ? "text-right font-mono text-xs text-slate-800 break-all"
            : "text-right text-sm font-medium text-slate-900"
        }
      >
        {value}
      </dd>
    </div>
  );
}
