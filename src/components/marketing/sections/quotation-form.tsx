"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LoadingButton } from "@/components/ui/loading-button";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { quotationSchema, type QuotationInput } from "@/lib/validation";
import { api, ApiClientError } from "@/lib/api-client";

import { MarketingSection, AccentWord } from "../section";

interface SubmitResponse {
  id: string;
  notificationStatus: "SENT" | "FAILED" | "SKIPPED";
}

const VOLUME_OPTIONS = [
  "< $50k / month",
  "$50k – $250k / month",
  "$250k – $1M / month",
  "$1M – $5M / month",
  "> $5M / month",
  "Not sure yet",
];

const GATEWAY_OPTIONS = [
  "Stripe",
  "Authorize.net",
  "Razorpay",
  "Adyen",
  "PayPal",
  "Manual / other",
  "Open to recommendation",
];

/**
 * Closing chapter — merged quotation form + contact channel.
 *
 * Two-column composition on the obsidian closing theme. Left rail is
 * the human story (email Vinay, 24h response, what happens next).
 * Right is the form — short, 5 visible fields + textarea.
 *
 * File path kept (`quotation-form.tsx`) so the page import contract
 * doesn't move. ContactSales is now dead — its content lives here.
 */
interface QuotationFormProps {
  /** Cloudflare Turnstile site key. When null the widget is omitted
   *  and the form posts without a `cfToken` — server-side verification
   *  is also disabled in that case, so local dev keeps working. */
  turnstileSiteKey?: string | null;
}

export function QuotationForm({ turnstileSiteKey }: QuotationFormProps = {}) {
  const form = useForm<QuotationInput>({
    resolver: zodResolver(quotationSchema),
    defaultValues: {
      fullName: "",
      companyName: "",
      workEmail: "",
      phone: "",
      country: "",
      expectedVolume: "",
      preferredGateway: "",
      currentStack: "",
      useCase: "",
      timeline: "",
      customRequirements: "",
      notes: "",
      source: "landing",
    },
  });

  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "ok"; ref: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [cfToken, setCfToken] = React.useState<string | null>(null);
  const requiresToken = Boolean(turnstileSiteKey);

  async function onSubmit(values: QuotationInput) {
    if (requiresToken && !cfToken) {
      setState({
        kind: "error",
        message:
          "Please complete the verification challenge before submitting.",
      });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const result = await api.post<SubmitResponse>("/api/quotations", {
        ...values,
        cfToken: cfToken ?? undefined,
      });
      setState({ kind: "ok", ref: result.id });
      form.reset();
      setCfToken(null);
    } catch (err) {
      // Cloudflare Turnstile tokens are single-use — burn the local
      // copy on error so the widget re-renders a fresh challenge.
      setCfToken(null);
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not submit your request. Please email vinaymaheshwari35@gmail.com.";
      setState({ kind: "error", message });
    }
  }

  return (
    <MarketingSection
      id="quote"
      theme="closing"
      eyebrow="For custom, high-volume, or procurement-led setups"
      title={
        <>
          If your setup needs more than{" "}
          <AccentWord>self-serve, start here.</AccentWord>
        </>
      }
      description={
        <>
          Most teams start free and grow from there. If you need scoped
          routing, regional gateway selection, a procurement track, or
          volumes that warrant a dedicated conversation — tell us about
          it and we&apos;ll respond within one business day.{" "}
          <a
            href="/signup"
            className="underline decoration-current/40 underline-offset-4 transition-colors hover:decoration-current"
          >
            Self-serve is one click away.
          </a>
        </>
      }
    >
      <div className="grid gap-12 lg:grid-cols-[1fr_1.3fr] lg:items-start">
        {/* ── Left rail ───────────────────────────────────────── */}
        <aside data-reveal data-reveal-order={0} className="lg:sticky lg:top-32">
          <a
            href="mailto:vinaymaheshwari35@gmail.com?subject=TraceTxn%20%E2%80%94%20requirements"
            className="group block rounded-2xl border p-6 backdrop-blur-sm transition-transform hover:-translate-y-px"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface-strong)",
            }}
          >
            <p
              className="font-mono text-[10.5px] uppercase tracking-[0.2em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              Direct line
            </p>
            <p className="mt-3 text-[18px] font-semibold tracking-tight">
              vinaymaheshwari35@gmail.com
            </p>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              Reaches the team building and operating TraceTxn. No drip,
              no SDR.
            </p>
            <p className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] font-medium">
              Open mail{" "}
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </p>
          </a>

          <ol className="mt-6 space-y-4">
            <Step k="01" t="Share your context" b="Volume, current stack, gateway preferences. Three minutes." />
            <Step k="02" t="Response in <24h" b="Tailored from product + ops, never a sequenced drip." />
            <Step k="03" t="Quotation + walkthrough" b="Scoped proposal with timelines, included surfaces, deployment path." />
          </ol>

          <div
            className="mt-6 rounded-2xl border p-5"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface)",
            }}
          >
            <p
              className="font-mono text-[10.5px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              For procurement / security review
            </p>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              Send your standard intake to the same address — we
              respond with SOC posture, retention policy, and recent
              third-party audit references.
            </p>
          </div>
        </aside>

        {/* ── Form ────────────────────────────────────────────── */}
        <div
          data-reveal
          data-reveal-order={1}
          className="rounded-3xl border p-6 lg:p-9 backdrop-blur-sm"
          style={{
            borderColor: "var(--m-border)",
            background: "var(--m-surface-strong)",
          }}
        >
          {state.kind === "ok" ? (
            <SuccessPanel reference={state.ref} />
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5"
              >
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="fullName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Vinay Maheshwari"
                            autoComplete="name"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="companyName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Company</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Acme Mobility, Inc."
                            autoComplete="organization"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="workEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Work email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="you@company.com"
                            autoComplete="email"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Country</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="United States"
                            autoComplete="country-name"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="expectedVolume"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expected payment volume</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-[13.5px] shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="" disabled>
                              Pick a range
                            </option>
                            {VOLUME_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="preferredGateway"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Preferred gateway</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-[13.5px] shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="">No preference</option>
                            {GATEWAY_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="useCase"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Use case · what you'd ship first</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={4}
                          placeholder="Rentals, marketplace, B2B invoicing… include the rough shape of the first integration."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="customRequirements"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Custom requirements{" "}
                        <span
                          className="font-normal"
                          style={{ color: "var(--m-fg-soft)" }}
                        >
                          (optional)
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder="Approval flows, multi-region, audit format, anything bespoke."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {state.kind === "error" ? (
                  <p
                    className="rounded-md border p-3 text-[12.5px]"
                    style={{
                      borderColor: "var(--destructive-border)",
                      background: "var(--destructive-soft)",
                      color: "var(--destructive)",
                    }}
                  >
                    {state.message}
                  </p>
                ) : null}

                {requiresToken ? (
                  <TurnstileWidget
                    siteKey={turnstileSiteKey}
                    onVerify={(token) => setCfToken(token)}
                    onExpire={() => setCfToken(null)}
                    onError={() => setCfToken(null)}
                    className="flex justify-center pt-1"
                  />
                ) : null}

                <div className="flex flex-col items-stretch gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <p
                    className="text-[11.5px]"
                    style={{ color: "var(--m-fg-soft)" }}
                  >
                    By submitting, you agree to be contacted by the
                    TraceTxn team about your request. No marketing.
                  </p>
                  <LoadingButton
                    type="submit"
                    loading={state.kind === "submitting"}
                    disabled={requiresToken && !cfToken}
                    className="h-11 rounded-full px-6 text-[14px] font-semibold"
                  >
                    Send requirements →
                  </LoadingButton>
                </div>
              </form>
            </Form>
          )}
        </div>
      </div>
    </MarketingSection>
  );
}

function Step({ k, t, b }: { k: string; t: string; b: string }) {
  return (
    <li className="grid grid-cols-[36px_1fr] items-baseline gap-3">
      <span
        className="font-mono text-[11px]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {k}
      </span>
      <div>
        <p className="text-[14px] font-medium">{t}</p>
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: "var(--m-fg-soft)" }}
        >
          {b}
        </p>
      </div>
    </li>
  );
}

function SuccessPanel({ reference }: { reference: string }) {
  return (
    <div className="py-6 text-center">
      <span
        className="mx-auto grid size-12 place-items-center rounded-full"
        style={{
          background:
            "linear-gradient(135deg, var(--m-ultraviolet) 0%, var(--m-cobalt) 100%)",
          color: "white",
        }}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-6"
          fill="none"
          aria-hidden
        >
          <path
            d="M3.5 8.5L6.5 11.5L12.5 5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h3 className="mt-5 text-[22px] font-semibold tracking-tight">
        Got it — talk soon.
      </h3>
      <p
        className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed"
        style={{ color: "var(--m-fg-soft)" }}
      >
        Your requirements landed. Expect a personal reply within one
        business day from vinaymaheshwari35@gmail.com.
      </p>
      <p
        className="mt-5 font-mono text-[11px]"
        style={{ color: "var(--m-fg-soft)" }}
      >
        ref · {reference.slice(0, 12)}
      </p>
    </div>
  );
}
