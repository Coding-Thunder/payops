"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheckIcon } from "lucide-react";

import { api, ApiClientError } from "@/lib/api-client";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatDateTime } from "@/lib/format";
import type { BrandingDTO, PublicConsentView } from "@/types";

interface ConsentFormProps {
  token: string;
  initialView: PublicConsentView;
  branding: BrandingDTO;
}

/**
 * Hosted consent → Stripe handoff.
 *
 * The page has one job: capture a digital signature and push the customer
 * into Stripe Checkout. There's no intermediate "you're confirmed" screen
 * because the spec demands an immediate handoff — any dead state between
 * sign and pay erodes conversion.
 *
 * Three runtime states:
 *  1. fresh REQUESTED — render the form (booking summary + required
 *     signature + confirm button).
 *  2. submitting       — disabled CTA + inline spinner copy.
 *  3. redirecting      — page replaces itself to the Stripe URL via
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
    return <RedirectingShell fallbackUrl={fallbackUrl} branding={branding} />;
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
          continue to {view.brandName}&apos;s secure Stripe checkout.
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
          You&apos;ll be taken directly to Stripe Checkout to complete
          payment. Your timestamp and IP are recorded against this booking
          as evidence of consent.{" "}
          <a
            href={`mailto:${branding.supportEmail}`}
            className="text-slate-600 underline-offset-2 hover:underline"
          >
            Email {branding.supportEmail}
          </a>{" "}
          if you need help.
        </p>
      </form>
    </div>
  );
}

function SummaryBlock({ view }: { view: PublicConsentView }) {
  const s = view.snapshot;
  return (
    <div className="border-t border-slate-100 px-6 py-5 sm:px-8">
      <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
        Order summary
      </p>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
          {formatCurrency(s.amount, s.currency)}
        </span>
      </div>
      <dl className="mt-4 divide-y divide-slate-100 text-sm">
        <DetailRow label="Customer" value={view.customerName} />
        <DetailRow label="Email" value={view.customerEmail} mono />
        {s.summary ? <DetailRow label="Items" value={s.summary} /> : null}
        {s.startsAt ? (
          <DetailRow label="Starts" value={formatDateTime(s.startsAt)} />
        ) : null}
        {s.endsAt ? (
          <DetailRow label="Ends" value={formatDateTime(s.endsAt)} />
        ) : null}
      </dl>
    </div>
  );
}

function RedirectingShell({
  fallbackUrl,
  branding,
}: {
  fallbackUrl: string | null;
  branding: BrandingDTO;
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
          We&apos;ve recorded your acknowledgement. You&apos;re being taken
          straight to Stripe Checkout to complete payment.
        </p>
        {fallbackUrl ? (
          <div className="mt-6 w-full max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left">
            <p className="text-xs font-medium text-amber-900">
              Redirect failed.
            </p>
            <p className="mt-1 text-[11px] text-amber-800">
              Your browser didn&apos;t open Stripe automatically. Continue
              securely below.
            </p>
            <a
              href={fallbackUrl}
              className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Continue to secure payment →
            </a>
          </div>
        ) : null}
        <p className="mt-6 text-[11px] text-slate-500">
          Trouble?{" "}
          <a
            href={`mailto:${branding.supportEmail}`}
            className="font-medium text-slate-700 underline-offset-2 hover:underline"
          >
            Email {branding.supportEmail}
          </a>
        </p>
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
