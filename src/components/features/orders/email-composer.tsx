"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SendIcon,
} from "lucide-react";

import { useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useActivityFeed } from "@/hooks/use-activity-feed";
import { orderQueryKey } from "@/hooks/use-order-query";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { McoEditDialog } from "@/components/features/orders/mco-edit-dialog";
import { DomainEventType } from "@/lib/constants/events";
import { cn } from "@/lib/utils";
import type { OrderDTO } from "@/types";

interface EmailComposerProps {
  order: OrderDTO;
  /** Pre-computed default subject/greeting/intro from the server. Renders
   *  in the iframe on first paint so the agent never sees an empty
   *  preview. */
  initialHtml: string;
  defaultSubject: string;
  /** Fired once when the send transitions from drafting → sent. Lets the
   *  parent (the dedicated /email screen) surface a "Continue to Order"
   *  CTA without lifting the entire send state out of the composer. */
  onSent?: (sentAtIso: string) => void;
}

interface DraftState {
  subject: string;
  greeting: string;
  intro: string;
  note: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

const PREVIEW_DEBOUNCE_MS = 350;

function buildDraft(order: OrderDTO, defaultSubject: string): DraftState {
  return {
    subject: defaultSubject,
    greeting: "",
    intro: "",
    note: "",
    customerName: order.customer.name,
    customerEmail: order.customer.email,
    customerPhone: order.customer.phone,
  };
}

/**
 * Split-pane payment-request composer.
 *
 * Left: editable subject + greeting + intro + note + customer details.
 * Right: live iframe rendering the same template the send endpoint uses.
 *
 * Send path:
 *   POST /api/orders/[id]/send-payment-request
 * Preview path:
 *   POST /api/orders/[id]/payment-request-preview  (returns HTML, no SMTP)
 *
 * After a successful send the editor freezes into a "sent" panel. We
 * subscribe to the existing SSE activity feed; if the customer pays
 * while the composer is still open we flip into a paid state so the
 * agent has zero-latency feedback.
 */
const GATEWAY_LABEL: Record<string, string> = {
  STRIPE: "Stripe",
  PAYPAL: "PayPal",
  RAZORPAY: "Razorpay",
  AUTHORIZE_NET: "Authorize.net",
  MANUAL: "Manual invoice",
};

export function EmailComposer({
  order,
  initialHtml,
  defaultSubject,
  onSent,
}: EmailComposerProps) {
  const router = useRouter();
  // Providers this organization may actually use. The server has the final
  // say either way — it ignores a value the brand has not enabled — but the
  // UI must not claim a gateway that is not in play.
  /**
   * Every provider this deployment knows about, each with whether it is
   * actually switched on. Rendering only the enabled ones would hide that
   * PayPal exists; rendering them all as selectable would imply it works.
   */
  const [providers, setProviders] = React.useState<
    { key: string; label: string; enabled: boolean }[]
  >([]);
  const [chosenGateway, setChosenGateway] = React.useState<string | null>(null);
  /**
   * How the operator intends to collect. MANUAL is not a gateway — the
   * domain keeps that distinction (`SUPPORTED` in resolve-gateway lists only
   * STRIPE and PAYPAL, and `initiatePayment` refuses MANUAL) — but it IS one
   * of the three answers to "how would you like to pay?", so it belongs in
   * the same decision. Leaving it out sent operators hunting for it on
   * another screen mid-call.
   */
  const [manualCollection, setManualCollection] = React.useState(false);
  const enabledProviders = React.useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{
        payments: {
          provider: string;
          enabledProviders: string[];
          supportedProviders: { key: string; label: string; enabled: boolean }[];
        } | null;
      }>("/api/organizations")
      .then((res) => {
        if (cancelled || !res?.payments) return;
        setProviders(res.payments.supportedProviders);
        setChosenGateway(res.payments.provider);
      })
      .catch(() => {
        // Non-fatal: the server picks the provider regardless.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<DraftState>(() =>
    buildDraft(order, defaultSubject),
  );
  const [html, setHtml] = React.useState(initialHtml);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [sentAt, setSentAt] = React.useState<string | null>(null);
  const [paidAt, setPaidAt] = React.useState<string | null>(
    order.payment.paidAt ?? null,
  );

  const { events } = useActivityFeed();

  // Watch the activity feed for an ORDER_PAID matching this order so
  // the composer flips into the paid state instantly. setState +
  // side-effects (toast, router.refresh) live inside the effect by
  // design — running them during render would fire on every parent
  // re-render. The rule's recommended "don't setState in effects" is a
  // false positive for this event-driven pattern.
  React.useEffect(() => {
    if (paidAt) return;
    for (const event of events) {
      if (event.type !== DomainEventType.ORDER_PAID) continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.orderId === order.id || payload.orderNumber === order.orderNumber) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPaidAt(event.at);
        toast.success("Payment received!", {
          description: `${order.orderNumber} · ${order.customer.name}`,
        });
        router.refresh();
        break;
      }
    }
  }, [events, order.id, order.orderNumber, order.customer.name, paidAt, router]);

  // Debounced preview: every change to the draft schedules a single
  // /payment-request-preview call. Abort prior in-flight requests so
  // we never paint stale HTML over a fresh keystroke.
  React.useEffect(() => {
    if (sentAt) return; // editor frozen after send
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const body = {
          ...buildPayload(draft, order),
          collection: manualCollection ? "MANUAL" : "GATEWAY",
        };
        const { html: rendered } = await api.post<{ html: string }>(
          `/api/orders/${order.id}/payment-request-preview`,
          body,
          { signal: controller.signal },
        );
        setHtml(rendered);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof ApiClientError
            ? err.message
            : "Couldn't refresh preview",
        );
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `manualCollection` is a dependency so switching method re-renders the
    // preview immediately; `order` covers a booking edit, so a re-priced
    // amount can never linger in the pane.
  }, [draft, order, sentAt, manualCollection]);

  async function handleSend() {
    setSending(true);
    try {
      const body = {
        ...buildPayload(draft, order),
        collection: manualCollection ? "MANUAL" : "GATEWAY",
      };
      await api.post(`/api/orders/${order.id}/send-payment-request`, body);
      const at = new Date().toISOString();
      setSentAt(at);
      onSent?.(at);
      toast.success(
        manualCollection ? "Consent request sent" : "Payment request sent",
        {
          description: `Sent to ${body.customer?.email ?? order.customer.email}`,
        },
      );
      await queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Could not send email";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  /** Step 1 of the send flow when the order doesn't have a payment
   *  link yet. The new linear architecture splits link generation from
   *  email dispatch so the agent's gateway choice + intent are
   *  unambiguous (and switching gateways later is just a dropdown). */
  async function handleGenerateLink() {
    setGenerating(true);
    try {
      // Only send a gateway when the operator genuinely chose between
      // several. The server ignores anything the organization has not
      // enabled, so this is a preference, never an instruction.
      await api.post(
        `/api/orders/${order.id}/generate-payment-link`,
        enabledProviders.length > 1 && chosenGateway
          ? { gateway: chosenGateway }
          : {},
      );
      toast.success("Payment link generated", {
        description: `Order ${order.orderNumber} is ready to send.`,
      });
      await queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : "Could not generate payment link";
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  function copyLink() {
    if (!order.payment.paymentUrl) return;
    navigator.clipboard.writeText(order.payment.paymentUrl).then(
      () => toast.success("Payment link copied"),
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    // Two-column composer. Preview pane sticks to the viewport on lg+
    // so the agent can scroll the editor (subject/greeting/intro/note +
    // customer fields) without losing sight of what the customer will
    // see. `items-start` is required for `position: sticky` to take
    // effect inside a grid row.
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <aside className="space-y-4">
        <PaymentSummaryCard
          order={order}
          sentAt={sentAt}
          paidAt={paidAt}
          onCopyLink={copyLink}
        />

        {/* The customer can change their mind mid-call, and before this the
            operator had to leave the page, find the order, edit it and come
            back — losing the composed draft on the way. Editing happens
            here, on the same order, and the page refreshes so the amount
            below is never the pre-edit figure. */}
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-0.5">
              <CardTitle className="text-[13px] tracking-tight">
                Booking
              </CardTitle>
              <p className="font-mono text-[11px] text-muted-foreground">
                {order.orderNumber}
              </p>
            </div>
            <McoEditDialog order={order} />
          </CardHeader>
          <CardContent className="space-y-1 text-[12px]">
            <SummaryRow
              label="Vehicle"
              value={`${order.vehicle.company} ${order.vehicle.type}`}
            />
            <SummaryRow label="Pick-up" value={formatDateTime(order.trip.pickupDate)} />
            <SummaryRow label="Drop-off" value={formatDateTime(order.trip.dropoffDate)} />
            <SummaryRow
              label="Amount"
              value={formatCurrency(order.pricing.amount, order.pricing.currency)}
              strong
            />
          </CardContent>
        </Card>

        {/* A link issued at an earlier amount must never be sent as if it
            were current. `priceRevision` is the order's own record that the
            amount moved; the backend supersedes the session, and this says
            so where the operator is about to act. */}
        {(order.payment.priceRevision ?? 0) > 0 && !order.payment.paymentUrl ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
            <p className="font-medium">This booking was re-priced.</p>
            <p className="mt-0.5">
              The previous payment link was superseded and can no longer be
              sent. Generate a new link for{" "}
              {formatCurrency(order.pricing.amount, order.pricing.currency)}, or
              choose Manual charge.
            </p>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] tracking-tight">
              Email content
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Subject">
              <Input
                value={draft.subject}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, subject: e.target.value }))
                }
                disabled={sending || !!sentAt}
              />
            </Field>
            <Field label="Greeting" hint="Defaults to “Hi {customer name},”">
              <Input
                value={draft.greeting}
                placeholder={`Hi ${order.customer.name},`}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, greeting: e.target.value }))
                }
                disabled={sending || !!sentAt}
              />
            </Field>
            <Field
              label="Intro paragraph"
              hint="Leave blank to use the standard copy."
            >
              <Textarea
                rows={4}
                value={draft.intro}
                placeholder="Thanks for booking with…"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, intro: e.target.value }))
                }
                disabled={sending || !!sentAt}
                maxLength={2000}
              />
            </Field>
            <Field
              label="Optional note"
              hint="Renders in a callout block above the support section."
            >
              <Textarea
                rows={3}
                value={draft.note}
                placeholder="e.g. Please complete payment by tomorrow 6 PM."
                onChange={(e) =>
                  setDraft((d) => ({ ...d, note: e.target.value }))
                }
                disabled={sending || !!sentAt}
                maxLength={2000}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] tracking-tight">
              Customer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Name">
              <Input
                value={draft.customerName}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, customerName: e.target.value }))
                }
                disabled={sending || !!sentAt}
              />
            </Field>
            <Field label="Email" hint="The email will be sent to this address.">
              <Input
                type="email"
                value={draft.customerEmail}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, customerEmail: e.target.value }))
                }
                disabled={sending || !!sentAt}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={draft.customerPhone}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, customerPhone: e.target.value }))
                }
                disabled={sending || !!sentAt}
              />
            </Field>
            <p className="text-[11.5px] text-muted-foreground">
              Edits here update the order itself, so the auto-confirmation
              email after payment also goes to this address.
            </p>
          </CardContent>
        </Card>

        {previewError ? (
          <Alert variant="destructive">
            <AlertTitle>Preview failed</AlertTitle>
            <AlertDescription>{previewError}</AlertDescription>
          </Alert>
        ) : null}

        {sentAt ? (
          <Card>
            <CardContent className="space-y-2 pt-5">
              <div className="flex items-center gap-2 text-emerald-700">
                <CheckCircle2Icon className="size-4" />
                <span className="text-[13px] font-medium">
                  Email sent {new Date(sentAt).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-[12px] text-muted-foreground">
                The composer is now read-only. Track the payment status on
                this page — it will update the moment the provider reports a
                success or failure.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-4 pt-4">
              {/* Gateway selector, driven by the ORGANIZATION's enabled
                  providers rather than a hardcoded list. It used to always
                  read "Stripe (available)" with PayPal greyed out as
                  "coming soon", which on a PayPal brand told the operator
                  the money was going somewhere it was not. Once the link is
                  generated the selector locks and shows what was used. */}
              {/* The operator's real question is "how would you like to
                  pay — Stripe, PayPal or manual?", so all three live in one
                  decision. Manual is labelled as a METHOD rather than a
                  gateway because the domain genuinely separates them: it is
                  not in `SUPPORTED`, `initiatePayment` refuses it, and it
                  settles money rather than routing it. */}
              <Field label="Payment method">
                {order.payment.gateway && !manualCollection ? (
                  <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                    {GATEWAY_LABEL[order.payment.gateway] ??
                      order.payment.gateway}
                  </div>
                ) : providers.length === 0 ? (
                  <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : (
                  /* Every supported provider is listed. A provider that is
                     not enabled is shown, disabled, and labelled — hiding it
                     would misstate what the product supports, and enabling
                     it would misstate what this deployment can do. The
                     server refuses a disabled provider independently; this
                     is signposting, not enforcement. */
                  <div
                    role="radiogroup"
                    // Must match the visible "Payment method" label. It read
                    // "Payment gateway", so a screen-reader user heard a
                    // different name than the one on screen — and heard
                    // Manual described as a gateway, which is the framing
                    // this control deliberately moved away from.
                    aria-label="Payment method"
                    className="space-y-1.5"
                  >
                    {providers.map((p) => (
                      <label
                        key={p.key}
                        className={
                          p.enabled
                            ? "flex cursor-pointer items-center gap-2.5 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted/40"
                            : "flex items-center gap-2.5 rounded-md border border-dashed border-input px-3 py-2 text-sm text-muted-foreground"
                        }
                      >
                        <input
                          type="radio"
                          name="payment-gateway"
                          value={p.key}
                          // Manual and a gateway are mutually exclusive and
                          // share one radio group, so a gateway is only
                          // checked while Manual is not — otherwise two
                          // inputs in the group claim to be selected and the
                          // browser keeps whichever it saw last.
                          checked={!manualCollection && chosenGateway === p.key}
                          disabled={!p.enabled}
                          onChange={() => {
                            setChosenGateway(p.key);
                            setManualCollection(false);
                          }}
                          className="accent-foreground"
                        />
                        <span className={p.enabled ? "" : "line-through"}>
                          {p.label}
                        </span>
                        {p.enabled ? null : (
                          <span className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide">
                            Coming soon
                          </span>
                        )}
                      </label>
                    ))}
                    <label
                      className="flex cursor-pointer items-center gap-2.5 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted/40"
                    >
                      <input
                        type="radio"
                        name="payment-gateway"
                        value="MANUAL"
                        checked={manualCollection}
                        onChange={() => setManualCollection(true)}
                        className="accent-foreground"
                      />
                      <span>Manual charge</span>
                      <span className="ml-auto text-[10.5px] text-muted-foreground">
                        No payment link
                      </span>
                    </label>
                  </div>
                )}
              </Field>

              {manualCollection ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
                  <p className="font-medium">
                    The customer will not receive a payment link.
                  </p>
                  <p className="mt-0.5">
                    They get a booking review and consent request. Once they
                    confirm, take the card on your terminal and then use{" "}
                    <span className="font-medium">Record manual payment</span>{" "}
                    on the order to settle it. Never enter card details here.
                  </p>
                </div>
              ) : null}

              {/* Two-step CTA — generate link first, send second. Once a
                  link exists the generate button flips to a disabled
                  "Link generated" affordance (re-running would orphan
                  the existing session on the gateway side) and the
                  send button takes over as the primary action. */}
              {/* What the operator is about to send, stated before they
                  send it. Amount comes from the order, so it is whatever the
                  latest edit left it at — never a stale figure. */}
              <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] space-y-0.5">
                <SummaryRow label="To" value={draft.customerEmail || order.customer.email} />
                <SummaryRow
                  label="Amount"
                  value={formatCurrency(order.pricing.amount, order.pricing.currency)}
                  strong
                />
                <SummaryRow
                  label="Method"
                  value={
                    manualCollection
                      ? "Manual charge"
                      : (chosenGateway && GATEWAY_LABEL[chosenGateway]) ??
                        (order.payment.gateway
                          ? GATEWAY_LABEL[order.payment.gateway] ?? order.payment.gateway
                          : "—")
                  }
                />
                <SummaryRow
                  label="Customer does"
                  value={
                    manualCollection
                      ? "Reviews and confirms the booking"
                      : "Confirms, then pays online"
                  }
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11.5px] text-muted-foreground">
                  {previewLoading
                    ? "Updating preview…"
                    : manualCollection
                      ? "No link is generated — the customer is asked to confirm only."
                      : order.payment.paymentUrl
                        ? "Link ready — send the email when you're done editing."
                        : "Generate the payment link to enable sending."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Manual has no link step at all, so the generate button
                      is absent rather than disabled — a greyed-out control
                      reads as "broken", which is the wrong story. */}
                  {manualCollection ? null : order.payment.paymentUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled
                      className="cursor-not-allowed border-emerald-200 bg-emerald-50 text-emerald-700 disabled:opacity-100"
                    >
                      <CheckCircle2Icon className="size-3.5" />
                      Link generated
                    </Button>
                  ) : (
                    <LoadingButton
                      onClick={handleGenerateLink}
                      loading={generating}
                      loadingText="Generating"
                      variant="outline"
                    >
                      Generate payment link
                    </LoadingButton>
                  )}
                  <LoadingButton
                    onClick={handleSend}
                    loading={sending}
                    loadingText="Sending"
                    disabled={!manualCollection && !order.payment.paymentUrl}
                  >
                    <SendIcon className="size-3.5" />
                    {manualCollection ? "Send consent request" : "Send payment request"}
                  </LoadingButton>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </aside>

      {/*
        Preview pane.
        - On lg+ it sticks below the chrome (topbar h-14 + tab bar h-9
          + ~0.5rem gap ≈ 6rem). The iframe itself is height-capped to
          the viewport so the user can scroll the form on the left
          while the preview stays visible; overflow inside the iframe
          is handled by the iframe's own scrollbar.
        - On mobile the section stacks below the form at its natural
          ~860 px so the email renders fully without cropping.
      */}
      <section className="space-y-3 lg:sticky lg:top-[6rem]">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight">Preview</h2>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em]",
              previewLoading ? "text-muted-foreground" : "text-muted-foreground/70",
            )}
          >
            {previewLoading ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : null}
            Live
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
          <iframe
            title="Email preview"
            srcDoc={html}
            className="block h-[860px] w-full border-0 bg-white lg:h-[calc(100vh-7.5rem)]"
            sandbox="allow-same-origin"
          />
        </div>
      </section>
    </div>
  );
}

function buildPayload(draft: DraftState, order: OrderDTO) {
  const customerPatch: Record<string, string> = {};
  if (draft.customerName.trim() && draft.customerName !== order.customer.name) {
    customerPatch.name = draft.customerName.trim();
  }
  if (draft.customerEmail.trim() && draft.customerEmail !== order.customer.email) {
    customerPatch.email = draft.customerEmail.trim();
  }
  if (draft.customerPhone.trim() && draft.customerPhone !== order.customer.phone) {
    customerPatch.phone = draft.customerPhone.trim();
  }
  return {
    subject: draft.subject.trim() || null,
    greeting: draft.greeting.trim() || null,
    intro: draft.intro.trim() || null,
    note: draft.note.trim() || null,
    customer: Object.keys(customerPatch).length > 0 ? customerPatch : undefined,
  };
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold tabular-nums" : "font-medium"}>
        {value}
      </span>
    </div>
  );
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

interface PaymentSummaryCardProps {
  order: OrderDTO;
  sentAt: string | null;
  paidAt: string | null;
  onCopyLink: () => void;
}

function PaymentSummaryCard({
  order,
  sentAt,
  paidAt,
  onCopyLink,
}: PaymentSummaryCardProps) {
  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-[13px] tracking-tight">
            {order.orderNumber}
          </CardTitle>
          <StatusBadge sentAt={sentAt} paidAt={paidAt} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-[12.5px]">
          <Meta label="Customer" value={order.customer.name} />
          <Meta label="Amount" value={formatAmount(order)} />
          <Meta label="Provider" value={order.provider?.name ?? "—"} />
          <Meta
            label="Vehicle"
            value={`${order.vehicle.company} · ${order.vehicle.type}`}
          />
        </dl>
        {order.payment.paymentUrl ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[12px]"
              onClick={onCopyLink}
            >
              <CopyIcon className="size-3" />
              Copy payment link
            </Button>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px]"
            >
              <a href={order.payment.paymentUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-3" />
                Open
              </a>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  sentAt,
  paidAt,
}: {
  sentAt: string | null;
  paidAt: string | null;
}) {
  if (paidAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-700">
        <CheckCircle2Icon className="size-3" />
        Paid
      </span>
    );
  }
  if (sentAt) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-blue-700">
        Sent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-amber-700">
      Draft
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-foreground">{value}</dd>
    </div>
  );
}

function formatAmount(order: OrderDTO): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: order.pricing.currency,
    }).format(order.pricing.amount);
  } catch {
    return `${order.pricing.currency} ${order.pricing.amount.toFixed(2)}`;
  }
}
