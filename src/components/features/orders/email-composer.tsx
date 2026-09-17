"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PencilIcon,
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
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DomainEventType } from "@/lib/constants/events";
import { OrderStatus } from "@/lib/constants/enums";
import { cn } from "@/lib/utils";
import { customerEmail as customerEmailSchema } from "@/lib/validation";
import { hasCustomerConsent } from "@/lib/consent";
import { isOperatorSupersede, outstandingHeldPayments } from "@/lib/payment-state";
import type { OrderDTO } from "@/types";

interface EmailComposerProps {
  order: OrderDTO;
  /** Pre-computed default subject/greeting/intro from the server. Renders
   *  in the iframe on first paint so the agent never sees an empty
   *  preview. */
  initialHtml: string;
  defaultSubject: string;
  /** Subject used instead while "Manual charge" is chosen and the operator
   *  has not typed their own. */
  defaultManualSubject?: string;
  /** Fired once when the send transitions from drafting → sent. Lets the
   *  parent (the dedicated /email screen) surface a "Continue to Order"
   *  CTA without lifting the entire send state out of the composer. */
  onSent?: (sentAtIso: string) => void;
  /** Whether the viewer may edit orders. STAFF may send requests but not
   *  edit; offering them an Edit link only led to an error page. */
  canEditOrder?: boolean;
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
  MANUAL: "Manual payment",
};

export function EmailComposer({
  order,
  initialHtml,
  defaultSubject,
  defaultManualSubject,
  onSent,
  canEditOrder = true,
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
  // Opens on the method the latest request used: a manual booking reopened
  // from its order page must not greet the operator with "Generate a Stripe
  // link". A live link on the order means a gateway send is what is pending.
  const [manualCollection, setManualCollection] = React.useState(() => {
    if (order.consent?.collectionMethod !== "MANUAL") return false;
    // A link generated AFTER the manual request is the operator's newer
    // decision; otherwise the manual request stands.
    const requested = order.consent.requestedAt
      ? Date.parse(order.consent.requestedAt)
      : 0;
    const linked = order.payment.initiatedAt
      ? Date.parse(order.payment.initiatedAt)
      : 0;
    return !(linked > requested);
  });
  /**
   * A different gateway picked while the order is already on one. "Stripe
   * failed — send it through PayPal" is answered here, on this page: the
   * switch stands the old link down and creates the new one on the SAME
   * order (`switchOrderGateway`), then the request is sent as usual.
   */
  const [switchTo, setSwitchTo] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);
  const [confirmSwitchOpen, setConfirmSwitchOpen] = React.useState(false);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = React.useState(false);
  const [confirmResendOpen, setConfirmResendOpen] = React.useState(false);
  // Focus goes back to what opened a dialog, and to Send once a new link is
  // ready — a controlled dialog otherwise drops focus to the page.
  const switchButtonRef = React.useRef<HTMLButtonElement>(null);
  const replaceButtonRef = React.useRef<HTMLButtonElement>(null);
  const sendButtonRef = React.useRef<HTMLButtonElement>(null);
  const focusSoon = (ref: React.RefObject<HTMLButtonElement | null>) =>
    window.setTimeout(() => ref.current?.focus(), 0);
  const enabledProviders = React.useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );

  // CTAs elsewhere link to `#payment-method`. This page renders after the
  // order loads, so the browser's own hash scroll finds nothing; do it here.
  React.useEffect(() => {
    if (window.location.hash !== "#payment-method") return;
    document
      .getElementById("payment-method")
      ?.scrollIntoView({ block: "start" });
  }, []);

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
  // An untouched subject follows the chosen method, through the same re-sync
  // that keeps untouched customer fields in step with the order.
  const subjectDefault =
    manualCollection && defaultManualSubject ? defaultManualSubject : defaultSubject;
  const [draft, setDraft] = React.useState<DraftState>(() =>
    buildDraft(order, defaultSubject),
  );
  // What the draft was filled from. When the order changes underneath the
  // composer (an edit in another tab, a background refetch), fields the
  // operator has NOT touched follow the order; fields they typed are kept.
  // Without this the composer kept the pre-edit name and email on screen,
  // mailed the old address, and wrote the old values back onto the order.
  const [draftBase, setDraftBase] = React.useState<DraftState>(() =>
    buildDraft(order, defaultSubject),
  );
  const freshBase = buildDraft(order, subjectDefault);
  const draftKeys = Object.keys(freshBase) as Array<keyof DraftState>;
  if (draftKeys.some((k) => freshBase[k] !== draftBase[k])) {
    const next = { ...draft };
    for (const k of draftKeys) {
      if (draft[k] === draftBase[k]) next[k] = freshBase[k];
    }
    setDraft(next);
    setDraftBase(freshBase);
  }
  const sendingRef = React.useRef(false);
  const generatingRef = React.useRef(false);

  // Where the order's payment actually stands — this, not "is there a URL on
  // record", decides what the operator may do next. A failed or expired
  // order keeps its old URL, and the page used to present that dead link as
  // ready to send.
  const isPaid =
    order.status === OrderStatus.PAID || Boolean(order.payment.paidAt);
  const linkLive =
    Boolean(order.payment.paymentUrl) &&
    (order.status === OrderStatus.LINK_GENERATED ||
      order.status === OrderStatus.PAYMENT_PENDING);
  const linkDead =
    order.status === OrderStatus.FAILED || order.status === OrderStatus.EXPIRED;
  const pinnedGateway =
    order.payment.gateway && order.payment.gateway !== "MANUAL"
      ? order.payment.gateway
      : null;
  // Moving an order to another gateway is an admin action on the server
  // (ORDER_UPDATE), the same permission as editing the order.
  const canSwitchGateway = canEditOrder && !isPaid;
  const switchTarget =
    switchTo && pinnedGateway && switchTo !== pinnedGateway && canSwitchGateway
      ? switchTo
      : null;
  // Once an order is on a gateway, that is the gateway a new link is made
  // on — unless the operator has chosen to switch.
  const effectiveGateway = switchTarget ?? pinnedGateway ?? chosenGateway;
  // A request already went out for the current amount (retired by an
  // amount change). Shown so a second send is a decision, not an accident.
  const lastRequestAt = order.consent?.requestedAt ?? null;
  // Was that request for the method chosen now? Resending it is then a
  // second email to the customer, and is confirmed first.
  const sameMethodAlreadySent =
    Boolean(lastRequestAt) &&
    order.consent?.collectionMethod === (manualCollection ? "MANUAL" : "GATEWAY");
  const customerConfirmed = hasCustomerConsent(order.consent?.status);
  const held = outstandingHeldPayments(order);
  const deadLinkReason =
    order.payment.failureReason && !isOperatorSupersede(order.payment.failureReason)
      ? order.payment.failureReason
      : null;
  const orderHref = `/app/orders/${order.id}`;
  const [html, setHtml] = React.useState(initialHtml);
  // Editing the order is a separate page now, and this draft is component
  // state — leaving drops whatever the operator has typed. The draft is
  // deliberately NOT carried across: it holds customer details copied from
  // the order, and restoring it after an edit would put the pre-edit name
  // or email back in front of the operator. So instead, ask first.
  const draftDirty = draftKeys.some((k) => draft[k] !== draftBase[k]);
  // Checked here as well as on the server, so a typo is named next to the
  // field and never reaches the send. Only an address the operator typed is
  // checked; an empty field keeps the order's own address.
  const emailProblem =
    draft.customerEmail !== draftBase.customerEmail && draft.customerEmail.trim()
      ? (customerEmailSchema.safeParse(draft.customerEmail).error?.issues[0]
          ?.message ?? null)
      : null;
  const [confirmEditOpen, setConfirmEditOpen] = React.useState(false);
  const editHref = `/app/orders/${order.id}/edit`;
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
    if (sentAt || isPaid) return; // editor frozen after send; nothing to send once paid
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        // An address still being typed is not previewed: the field already
        // shows what is wrong, and the preview kept failing alongside it.
        const previewDraft = emailProblem
          ? { ...draft, customerEmail: draftBase.customerEmail }
          : draft;
        const body = {
          ...buildPayload(previewDraft, draftBase),
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
  }, [draft, draftBase, order, sentAt, manualCollection, isPaid, emailProblem]);

  async function handleSend() {
    // A second click in the same tick must not send a second email: the
    // disabled state only lands on the next render.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const body = {
        ...buildPayload(draft, draftBase),
        collection: manualCollection ? "MANUAL" : "GATEWAY",
      };
      const res = await api.post<{ order: OrderDTO }>(
        `/api/orders/${order.id}/send-payment-request`,
        body,
      );
      const at = new Date().toISOString();
      setSentAt(at);
      onSent?.(at);
      toast.success(
        manualCollection ? "Consent request sent" : "Payment request sent",
        {
          // The address the server actually used, not what this screen
          // believed the address to be.
          description: `Sent to ${res?.order?.customer?.email ?? body.customer?.email ?? order.customer.email}`,
        },
      );
      await queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
    } catch (err) {
      toast.error(errorText(err, "Could not send email"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  /** Step 1 of the send flow when the order doesn't have a payment
   *  link yet. The new linear architecture splits link generation from
   *  email dispatch so the agent's gateway choice + intent are
   *  unambiguous (and switching gateways later is just a dropdown). */
  async function handleSwitchGateway() {
    if (!switchTarget || generatingRef.current) return;
    generatingRef.current = true;
    setSwitching(true);
    let switched = false;
    try {
      await api.post(`/api/orders/${order.id}/switch-gateway`, {
        gateway: switchTarget,
      });
      toast.success(
        `New ${GATEWAY_LABEL[switchTarget] ?? switchTarget} payment link generated`,
        { description: `Order ${order.orderNumber} is ready to send.` },
      );
      setSwitchTo(null);
      switched = true;
    } catch (err) {
      toast.error(errorText(err, "Could not switch gateway"));
    } finally {
      // Success or not, the order may have changed (a failed switch can
      // already have stood the old link down).
      await queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
      generatingRef.current = false;
      setSwitching(false);
      // Send only becomes enabled once the refreshed order has rendered.
      if (switched) window.setTimeout(() => sendButtonRef.current?.focus(), 150);
    }
  }

  async function handleGenerateLink(mode: "auto" | "replace" = "auto") {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    try {
      if ((linkDead || mode === "replace") && pinnedGateway) {
        // A failed, expired or re-priced order needs a REPLACEMENT link on
        // the gateway it is pinned to. The first-link endpoint refuses those
        // orders, which left the operator stuck on this page right after
        // being told to "generate a new payment link".
        await api.post(`/api/orders/${order.id}/regenerate-link`, {});
      } else {
        // Only send a gateway when the operator genuinely chose between
        // several. The server ignores anything the organization has not
        // enabled, so this is a preference, never an instruction.
        await api.post(
          `/api/orders/${order.id}/generate-payment-link`,
          enabledProviders.length > 1 && effectiveGateway
            ? { gateway: effectiveGateway }
            : {},
        );
      }
      toast.success("Payment link generated", {
        description: `Order ${order.orderNumber} is ready to send.`,
      });
      await queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
      // The button that was pressed is replaced by "Link generated"; the
      // next step is sending.
      window.setTimeout(() => sendButtonRef.current?.focus(), 150);
    } catch (err) {
      toast.error(errorText(err, "Could not generate payment link"));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }

  function copyLink() {
    if (!linkLive || !order.payment.paymentUrl) return;
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
          sentAt={sentAt ?? lastRequestAt}
          paidAt={paidAt}
          linkLive={linkLive}
          onCopyLink={copyLink}
        />

        {/* The customer can change their mind mid-call. Edit order opens the
            same form that created the order, amends THIS order, and returns
            here with the saved order already in the query cache — so the
            amount below is never the pre-edit figure. */}
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
            {canEditOrder ? (
              <>
            <Button asChild variant="outline" size="sm">
              <Link
                href={editHref}
                onNavigate={(event) => {
                  if (!draftDirty || sentAt) return;
                  event.preventDefault();
                  setConfirmEditOpen(true);
                }}
              >
                <PencilIcon className="size-3.5" />
                Edit order
              </Link>
            </Button>
            <ConfirmDialog
              open={confirmEditOpen}
              onOpenChange={setConfirmEditOpen}
              title="Leave this email draft?"
              description="Edit order opens the full order form. The subject, greeting, intro, note and customer details you have changed here will not be kept."
              confirmLabel="Edit order anyway"
              cancelLabel="Keep drafting"
              tone="warning"
              onConfirm={() => {
                setConfirmEditOpen(false);
                router.push(editHref);
              }}
            />
              </>
            ) : null}
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
        {!isPaid &&
        !linkLive &&
        order.payment.failureReason === "Superseded by an amount change" ? (
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
                disabled={sending || !!sentAt || isPaid}
              />
            </Field>
            <Field label="Greeting" hint="Defaults to “Hi {customer name},”">
              <Input
                value={draft.greeting}
                placeholder={`Hi ${order.customer.name},`}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, greeting: e.target.value }))
                }
                disabled={sending || !!sentAt || isPaid}
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
                disabled={sending || !!sentAt || isPaid}
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
                disabled={sending || !!sentAt || isPaid}
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
                disabled={sending || !!sentAt || isPaid}
              />
            </Field>
            <Field
              label="Email"
              hint="The email will be sent to this address."
              error={emailProblem}
              errorId="composer-email-error"
            >
              <Input
                type="email"
                aria-invalid={emailProblem ? true : undefined}
                aria-describedby={emailProblem ? "composer-email-error" : undefined}
                value={draft.customerEmail}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, customerEmail: e.target.value }))
                }
                disabled={sending || !!sentAt || isPaid}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={draft.customerPhone}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, customerPhone: e.target.value }))
                }
                disabled={sending || !!sentAt || isPaid}
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
              {held.length > 0 ? (
                <Alert variant="destructive" className="text-red-800 dark:text-red-200">
                  <AlertTitle>Payment already received on an earlier link</AlertTitle>
                  <AlertDescription>
                    The customer has paid on a link this order no longer uses.
                    Do not ask them to pay again until it is reconciled on the{" "}
                    <Link href={orderHref} className="underline">
                      order page
                    </Link>
                    .
                  </AlertDescription>
                </Alert>
              ) : null}
              {/* Not a <label>: a label wrapping a radio group hands a click
                  on the caption to the first radio, silently switching the
                  method back to Stripe. */}
              <div id="payment-method" className="scroll-mt-24 space-y-1.5">
                <span
                  id="payment-method-label"
                  className="block text-[12px] font-medium text-foreground"
                >
                  Payment method
                </span>
                {isPaid ? (
                  // Settled: the method is history, not a choice.
                  <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                    Paid ·{" "}
                    {order.payment.gateway
                      ? (GATEWAY_LABEL[order.payment.gateway] ??
                        order.payment.gateway)
                      : "—"}
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
                    aria-labelledby="payment-method-label"
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
                          checked={!manualCollection && effectiveGateway === p.key}
                          // The choice stays open after a failure — the order
                          // used to lock to its gateway and hide Manual — but
                          // a DIFFERENT gateway is the order page's "Try
                          // another gateway", which stands the old link down.
                          disabled={
                            !p.enabled ||
                            (pinnedGateway !== null &&
                              p.key !== pinnedGateway &&
                              !canSwitchGateway)
                          }
                          onChange={() => {
                            setChosenGateway(p.key);
                            setSwitchTo(
                              pinnedGateway && p.key !== pinnedGateway ? p.key : null,
                            );
                            setManualCollection(false);
                          }}
                          className="accent-foreground"
                        />
                        <span className={p.enabled ? "" : "line-through"}>
                          {p.label}
                        </span>
                        {!p.enabled ? (
                          <span className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide">
                            Coming soon
                          </span>
                        ) : pinnedGateway !== null && p.key !== pinnedGateway ? (
                          <span className="ml-auto text-[10.5px] text-muted-foreground">
                            {canSwitchGateway
                              ? `Replaces the ${GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway} link`
                              : "Only an admin can switch gateways"}
                          </span>
                        ) : null}
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
                        onChange={() => {
                          setManualCollection(true);
                          setSwitchTo(null);
                        }}
                        className="accent-foreground"
                      />
                      <span>Manual charge</span>
                      <span className="ml-auto text-[10.5px] text-muted-foreground">
                        No payment link
                      </span>
                    </label>
                  </div>
                )}
              </div>

              {manualCollection ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
                  <p className="font-medium">
                    The customer will not receive a payment link.
                  </p>
                  <p className="mt-0.5">
                    They get a booking review and consent request. Once they
                    confirm, take the card on your terminal and then{" "}
                    {canEditOrder ? (
                      <>
                        use{" "}
                        <span className="font-medium">Record manual payment</span>{" "}
                        on the order to settle it.
                      </>
                    ) : (
                      "ask an admin to record the payment on the order — recording it needs admin access."
                    )}{" "}
                    Never enter card details here.
                  </p>
                  {pinnedGateway && linkDead && order.payment.paymentUrl ? (
                    <p className="mt-1.5 font-medium">
                      Sending this request also stands down the declined{" "}
                      {GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway} checkout,
                      in case the customer still has it open — any payment made
                      on it is held for review.
                    </p>
                  ) : null}
                  {pinnedGateway && linkLive ? (
                    <p className="mt-1.5 font-medium">
                      Sending this request stands down the customer&apos;s{" "}
                      {GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway} link: we
                      ask {GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway} to
                      close it, and any payment still made on it is held for
                      review rather than accepted. If they paid before you
                      send, the order will already show as paid — check it
                      before charging the card.
                    </p>
                  ) : null}
                  {order.consent?.collectionMethod === "MANUAL" && lastRequestAt ? (
                    <p className="mt-1.5 font-medium">
                      {customerConfirmed
                        ? "The customer has confirmed this manual request. "
                        : `Requested ${formatDateTime(lastRequestAt)} — waiting for the customer to confirm. `}
                      <Link href={orderHref} className="underline">
                        {customerConfirmed
                          ? canEditOrder
                            ? "Record the payment on the order page"
                            : "Open the order (an admin records the payment)"
                          : "Open the order"}
                      </Link>
                    </p>
                  ) : null}
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
              {linkLive && order.payment.detailsChangedAt ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  Booking details changed after this link was created. The
                  customer&apos;s checkout page still shows the old ones —{" "}
                  <span className="font-medium">Replace link</span> to update it.
                </div>
              ) : null}
              <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] space-y-0.5">
                <SummaryRow label="To" value={draft.customerEmail || order.customer.email} />
                {/* The MCO — what this request charges now. Always the order's
                    current amount, so a new link or a resend never uses an
                    older figure. */}
                <SummaryRow
                  label={isPaid ? "Amount (MCO)" : "Charging now (MCO)"}
                  value={formatCurrency(order.pricing.amount, order.pricing.currency)}
                  strong
                />
                <SummaryRow
                  label="Method"
                  value={
                    isPaid
                      ? `Paid · ${order.payment.gateway ? (GATEWAY_LABEL[order.payment.gateway] ?? order.payment.gateway) : "—"}`
                      : manualCollection
                        ? "Manual charge"
                        : effectiveGateway
                          ? (GATEWAY_LABEL[effectiveGateway] ?? effectiveGateway)
                          : "—"
                  }
                />
                {isPaid ? null : (
                  <SummaryRow
                    label="Customer does"
                    value={
                      manualCollection
                        ? "Reviews and confirms the booking"
                        : !switchTarget &&
                            customerConfirmed &&
                            order.consent?.collectionMethod === "GATEWAY"
                          ? "Pays online (already confirmed)"
                          : "Confirms, then pays online"
                    }
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11.5px] text-muted-foreground">
                  {isPaid
                    ? "This order is paid — there is nothing to send."
                    : held.length > 0
                      ? "A payment is already held for this order. Reconcile it on the order page before asking the customer to pay again."
                    : switchTarget
                      ? `Creates a ${GATEWAY_LABEL[switchTarget] ?? switchTarget} link for this same order${linkLive ? ` and stops the ${GATEWAY_LABEL[pinnedGateway!] ?? pinnedGateway} link` : ""}. Send it once it is ready.`
                      : previewLoading
                      ? "Updating preview…"
                      : manualCollection
                        ? "No link is generated — the customer is asked to confirm only."
                        : linkLive && lastRequestAt
                          ? `Already sent ${formatDateTime(lastRequestAt)}. Sending again emails the customer again.`
                          : linkLive
                          ? "Link ready — send the email when you're done editing."
                          : linkDead && pinnedGateway
                            ? `The previous ${GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway} link can no longer be paid${deadLinkReason ? ` (${deadLinkReason})` : ""}. Generate a new one, or choose another payment method above.`
                            : "Generate the payment link to enable sending."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Manual has no link step at all, so the generate button
                      is absent rather than disabled — a greyed-out control
                      reads as "broken", which is the wrong story. */}
                  {isPaid || manualCollection || held.length > 0 ? null : switchTarget ? (
                    <LoadingButton
                      ref={switchButtonRef}
                      onClick={() =>
                        linkLive ? setConfirmSwitchOpen(true) : void handleSwitchGateway()
                      }
                      loading={switching}
                      loadingText="Switching"
                      variant="outline"
                    >
                      {`Switch to ${GATEWAY_LABEL[switchTarget] ?? switchTarget} & generate link`}
                    </LoadingButton>
                  ) : linkLive ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        disabled
                        className="cursor-not-allowed border-emerald-200 bg-emerald-50 text-emerald-700 disabled:opacity-100"
                      >
                        <CheckCircle2Icon className="size-3.5" />
                        Link generated
                      </Button>
                      {pinnedGateway ? (
                        // After an edit to what the checkout shows (car,
                        // dates, provider, email) the operator is told to
                        // make a new link; this is where they can.
                        <LoadingButton
                          ref={replaceButtonRef}
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmReplaceOpen(true)}
                          loading={generating}
                          loadingText="Replacing"
                        >
                          Replace link
                        </LoadingButton>
                      ) : null}
                    </>
                  ) : (
                    <LoadingButton
                      onClick={() => void handleGenerateLink()}
                      loading={generating}
                      loadingText="Generating"
                      variant="outline"
                    >
                      {linkDead && pinnedGateway
                        ? "Generate a new payment link"
                        : "Generate payment link"}
                    </LoadingButton>
                  )}
                  {isPaid ? null : (
                    <LoadingButton
                      ref={sendButtonRef}
                      onClick={() =>
                        sameMethodAlreadySent
                          ? setConfirmResendOpen(true)
                          : void handleSend()
                      }
                      loading={sending}
                      loadingText="Sending"
                      // A gateway request needs a link the customer can
                      // actually pay; a dead one is not "ready".
                      disabled={
                        held.length > 0 ||
                        Boolean(emailProblem) ||
                        (!manualCollection && (!linkLive || Boolean(switchTarget)))
                      }
                    >
                      <SendIcon className="size-3.5" />
                      {manualCollection ? "Send consent request" : "Send payment request"}
                    </LoadingButton>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        <ConfirmDialog
          open={confirmSwitchOpen}
          onOpenChange={(open) => {
            setConfirmSwitchOpen(open);
            if (!open) focusSoon(switchButtonRef);
          }}
          title={`Stand down the ${pinnedGateway ? (GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway) : "current"} link and switch?`}
          description={`A new ${switchTarget ? (GATEWAY_LABEL[switchTarget] ?? switchTarget) : ""} link is created for this same order. We ask ${pinnedGateway ? (GATEWAY_LABEL[pinnedGateway] ?? pinnedGateway) : "the current gateway"} to close the current link; if the customer still pays it, that payment is held for review and not accepted. If they have already paid, check the order instead of switching.`}
          confirmLabel="Switch gateway"
          cancelLabel="Keep the current link"
          tone="warning"
          onConfirm={() => {
            setConfirmSwitchOpen(false);
            void handleSwitchGateway();
          }}
        />
        <ConfirmDialog
          open={confirmReplaceOpen}
          onOpenChange={(open) => {
            setConfirmReplaceOpen(open);
            if (!open) focusSoon(replaceButtonRef);
          }}
          title="Replace the payment link?"
          description="The customer's current link will stop working and a new one is created with the order's current details. Send the new link afterwards."
          confirmLabel="Replace link"
          cancelLabel="Keep the current link"
          tone="warning"
          onConfirm={() => {
            setConfirmReplaceOpen(false);
            void handleGenerateLink("replace");
          }}
        />
        <ConfirmDialog
          open={confirmResendOpen}
          onOpenChange={(open) => {
            setConfirmResendOpen(open);
            if (!open) focusSoon(sendButtonRef);
          }}
          title="Send this request again?"
          description={`A request was already sent${lastRequestAt ? ` on ${formatDateTime(lastRequestAt)}` : ""}. Sending again emails ${draft.customerEmail || order.customer.email} another copy.`}
          confirmLabel="Send again"
          cancelLabel="Don't send"
          tone="warning"
          onConfirm={() => {
            setConfirmResendOpen(false);
            void handleSend();
          }}
        />
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
        {isPaid ? (
          // A paid order has no request to send; previewing one only showed
          // "Payment requested — you pay today" next to "Paid".
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            This order is paid, so there is no payment request to preview. The
            customer&apos;s confirmation email is sent automatically; resend it
            from the order page if needed.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
            <iframe
              title="Email preview"
              srcDoc={html}
              className="block h-[860px] w-full border-0 bg-white lg:h-[calc(100vh-7.5rem)]"
              sandbox="allow-same-origin"
            />
          </div>
        )}
      </section>
    </div>
  );
}

/** An API error as the operator should read it, with the wait on a 429. */
function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  const wait = (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
  if (err.status === 429) {
    return `Too many requests for this order. Try again${wait ? ` in ${wait} seconds` : " in a minute"}.`;
  }
  return err.message;
}

/**
 * The send request. Customer fields are included ONLY when the operator
 * edited them in this composer — compared against what the draft was filled
 * from, not against the order as it is now. Comparing against the current
 * order made every field that had changed elsewhere look like an edit, so an
 * untouched composer sent the stale values and reverted the correction.
 */
function buildPayload(draft: DraftState, base: DraftState) {
  const customerPatch: Record<string, string> = {};
  if (draft.customerName.trim() && draft.customerName !== base.customerName) {
    customerPatch.name = draft.customerName.trim();
  }
  if (draft.customerEmail.trim() && draft.customerEmail !== base.customerEmail) {
    customerPatch.email = draft.customerEmail.trim();
  }
  if (draft.customerPhone.trim() && draft.customerPhone !== base.customerPhone) {
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
  error?: string | null;
  errorId?: string;
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

function Field({ label, hint, error, errorId, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="block text-[11px] font-medium text-destructive"
        >
          {error}
        </span>
      ) : hint ? (
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

interface PaymentSummaryCardProps {
  order: OrderDTO;
  sentAt: string | null;
  paidAt: string | null;
  /** Only a link the customer can still pay is offered for copying. */
  linkLive: boolean;
  onCopyLink: () => void;
}

function PaymentSummaryCard({
  order,
  sentAt,
  paidAt,
  linkLive,
  onCopyLink,
}: PaymentSummaryCardProps) {
  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-[13px] tracking-tight">
            {order.orderNumber}
          </CardTitle>
          <StatusBadge
            status={order.status}
            sentAt={sentAt}
            paidAt={paidAt}
            manualRequested={order.consent?.collectionMethod === "MANUAL"}
            stoodDown={
              isOperatorSupersede(order.payment.failureReason) &&
              outstandingHeldPayments(order).length === 0
            }
          />
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
        {linkLive && order.payment.paymentUrl ? (
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
  status,
  sentAt,
  paidAt,
  manualRequested = false,
  stoodDown = false,
}: {
  status: OrderStatus;
  sentAt: string | null;
  paidAt: string | null;
  manualRequested?: boolean;
  /** The link was stopped by PayOps (re-price, regenerate, switch), not declined. */
  stoodDown?: boolean;
}) {
  // A manual request after a failed link is the operator's next step, not a
  // failure: the badge says what is actually pending.
  if (!paidAt && manualRequested) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-blue-700">
        Manual requested
      </span>
    );
  }
  // A failed or expired link is not a draft waiting to be sent — saying so
  // hid the one fact the operator needed before sending anything.
  if (!paidAt && (status === OrderStatus.FAILED || status === OrderStatus.EXPIRED)) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-red-700">
        {status === OrderStatus.FAILED
          ? stoodDown
            ? "New link needed"
            : "Link failed"
          : "Link expired"}
      </span>
    );
  }
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
