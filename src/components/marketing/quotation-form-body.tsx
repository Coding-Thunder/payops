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

/**
 * Quotation form — bare body, no section chrome.
 *
 * Drops the MarketingSection wrapper + the sticky-aside contact card
 * so the form can be embedded inside the document's ClosingRegion
 * as a small enclosure rather than a full marketing chapter.
 */

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

interface QuotationFormBodyProps {
  turnstileSiteKey?: string | null;
}

export function QuotationFormBody({
  turnstileSiteKey,
}: QuotationFormBodyProps = {}) {
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
      setCfToken(null);
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not submit your request. Please email vinaymaheshwari35@gmail.com.";
      setState({ kind: "error", message });
    }
  }

  if (state.kind === "ok") {
    return <SuccessPanel reference={state.ref} />;
  }

  return (
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
              <FormLabel>Use case · what you&apos;d ship first</FormLabel>
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
                <span className="font-normal text-muted-foreground">
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
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[12.5px] text-destructive">
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
          <p className="text-[11.5px] text-muted-foreground">
            By submitting, you agree to be contacted by the TraceTxn team
            about your request. No marketing.
          </p>
          <LoadingButton
            type="submit"
            loading={state.kind === "submitting"}
            disabled={requiresToken && !cfToken}
            className="h-11 rounded-md px-6 text-[13px] font-semibold"
          >
            Send requirements →
          </LoadingButton>
        </div>
      </form>
    </Form>
  );
}

function SuccessPanel({ reference }: { reference: string }) {
  return (
    <div className="py-6">
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden
          className="inline-block size-2 rounded-full bg-success"
        />
        <h3 className="text-[16px] font-semibold tracking-tight text-success">
          Received
        </h3>
      </div>
      <p className="mt-3 max-w-[44ch] text-[13.5px] leading-relaxed text-muted-foreground">
        Your requirements landed. Expect a personal reply within one
        business day from vinaymaheshwari35@gmail.com.
      </p>
      <p className="mt-5 font-mono text-[11px] tabular-nums text-muted-foreground">
        ref · {reference.slice(0, 12)}
      </p>
    </div>
  );
}
