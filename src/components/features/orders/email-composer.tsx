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
import { api, ApiClientError } from "@/lib/api-client";
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
export function EmailComposer({
  order,
  initialHtml,
  defaultSubject,
}: EmailComposerProps) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<DraftState>(() =>
    buildDraft(order, defaultSubject),
  );
  const [html, setHtml] = React.useState(initialHtml);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
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
        const body = buildPayload(draft, order);
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
  }, [draft, order, sentAt]);

  async function handleSend() {
    setSending(true);
    try {
      const body = buildPayload(draft, order);
      await api.post(`/api/orders/${order.id}/send-payment-request`, body);
      setSentAt(new Date().toISOString());
      toast.success("Email sent", {
        description: `Sent to ${body.customer?.email ?? order.customer.email}`,
      });
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Could not send email";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  function copyLink() {
    if (!order.payment.checkoutUrl) return;
    navigator.clipboard.writeText(order.payment.checkoutUrl).then(
      () => toast.success("Stripe link copied"),
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <aside className="space-y-4">
        <PaymentSummaryCard
          order={order}
          sentAt={sentAt}
          paidAt={paidAt}
          onCopyLink={copyLink}
        />

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
                this page — it will update the moment Stripe reports a
                success or failure.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11.5px] text-muted-foreground">
              {previewLoading ? "Updating preview…" : "Preview updates as you type."}
            </p>
            <LoadingButton
              onClick={handleSend}
              loading={sending}
              disabled={!order.payment.checkoutUrl}
            >
              <SendIcon className="size-3.5" />
              Send email
            </LoadingButton>
          </div>
        )}
      </aside>

      <section className="space-y-3">
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
            className="block h-[860px] w-full border-0 bg-white"
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
        {order.payment.checkoutUrl ? (
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
              <a href={order.payment.checkoutUrl} target="_blank" rel="noreferrer">
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
