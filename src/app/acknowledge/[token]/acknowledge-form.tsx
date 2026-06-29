"use client";

import { useState } from "react";

import { api, ApiClientError } from "@/lib/api-client";

/** Mirror of the server's PublicAcknowledgementView (kept local so this client
 *  component never imports the server-only service module). */
interface AcknowledgementView {
  orderNumber: string;
  customerName: string;
  brandName: string;
  supportEmail: string;
  termsText: string;
  termsVersion: string;
  acknowledgedAt: string | null;
}

interface AcknowledgeFormProps {
  token: string;
  initialView: AcknowledgementView;
}

export function AcknowledgeForm({ token, initialView }: AcknowledgeFormProps) {
  const [view, setView] = useState<AcknowledgementView>(initialView);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paragraphs = view.termsText
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const acknowledged = Boolean(view.acknowledgedAt);

  async function onAgree() {
    if (submitting || acknowledged) return;
    setSubmitting(true);
    setError(null);
    try {
      const next = await api.post<AcknowledgementView>(
        `/api/acknowledge/${token}`,
        {},
      );
      setView(next);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not record your acknowledgement. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-gradient-to-br from-slate-50 via-white to-white px-6 pt-8 pb-6 sm:px-8 sm:pt-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Terms &amp; Conditions
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
          Hi {view.customerName.split(" ")[0]},
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Please review and acknowledge the terms for your {view.brandName}{" "}
          booking{" "}
          <span className="font-mono text-slate-800">{view.orderNumber}</span>.
        </p>
      </div>

      <div className="border-t border-slate-100 px-6 py-5 sm:px-8">
        <div className="max-h-[42vh] space-y-2.5 overflow-y-auto pr-1">
          {paragraphs.length > 0 ? (
            paragraphs.map((p, i) => (
              <p key={i} className="text-sm leading-relaxed text-slate-700">
                {p}
              </p>
            ))
          ) : (
            <p className="text-sm text-slate-500">
              No terms have been provided for this booking.
            </p>
          )}
        </div>
        <p className="mt-3 text-[11px] text-slate-400">
          Terms version {view.termsVersion}
        </p>
      </div>

      <div className="border-t border-slate-100 px-6 py-6 sm:px-8">
        {acknowledged ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-sm font-semibold text-emerald-900">
              Thank you. Your acknowledgement has been successfully recorded.
            </p>
            <p className="mt-1 text-xs text-emerald-800">
              You agreed to the terms on{" "}
              {new Date(view.acknowledgedAt as string).toLocaleString()}.
            </p>
          </div>
        ) : (
          <>
            {error ? (
              <p className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              onClick={onAgree}
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {submitting ? "Recording…" : "I Agree"}
            </button>
            <p className="mt-3 text-center text-[11px] text-slate-500">
              Your acknowledgement, timestamp, and IP are recorded against this
              booking.{" "}
              <a
                href={`mailto:${view.supportEmail}`}
                className="text-slate-600 underline-offset-2 hover:underline"
              >
                Email {view.supportEmail}
              </a>{" "}
              if you need help.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
