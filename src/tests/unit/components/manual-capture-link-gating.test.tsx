import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { OrderDetailPageContent } from "@/components/features/orders/order-detail-page-content";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { PaymentStatusFloater } from "@/components/features/orders/payment-status-floater";
import {
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentStatus,
  Currency,
  OrderStatus,
  PAYMENT_CAPTURE_STATUSES,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  USER_ROLES,
  UserRole,
} from "@/lib/constants/enums";
import { PaymentCaptureStatusLabel } from "@/lib/constants/labels";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import type { OrderCharge, OrderDTO, OrderPaymentCapture } from "@/types";

/**
 * MANUAL CAPTURE: WHEN THE ORDER PAGE STILL HANDS OUT THE PAYMENT LINK.
 *
 * A manual-capture checkout AUTHORIZES the card, and the link is spent once
 * the customer completes it:
 *
 *   - while the hold is LIVE (AUTHORIZED, CAPTURE_PENDING, CAPTURE_FAILED)
 *     the operator captures or releases it. Sharing the old link or
 *     regenerating it would only invite a second hold, and the server
 *     refuses both (regenerate: "This order has a live authorization…";
 *     send request: "The customer has already authorized this payment…").
 *     Whatever the payment status says: a hold standing on a FAILED or an
 *     EXPIRED order is captured or released all the same, never replaced,
 *     and never archived from under the operator (an archived order can be
 *     neither captured nor released; the server refuses: "This order has a
 *     live card hold…").
 *   - once the hold is SPENT (CANCELLED, AUTHORIZATION_EXPIRED) only a NEW
 *     link can collect, so the card offers "Generate a new payment link",
 *     as it always has for a FAILED or EXPIRED order.
 *   - once the order is PAID it is settled, even while its authorization
 *     record still reads a hold that stands, or one still awaited (the
 *     money can land before the record catches up): the card reads the
 *     record as captured, and nothing is left to capture, release or
 *     re-link. Nor is a new link offered beside a spent hold on it.
 *
 * Before checkout (PENDING_AUTHORIZATION) the link is live: its controls
 * and the page's banner read exactly as they do for an automatic-capture
 * order (`payment.capture` null), which must not change at all.
 *
 * The authorization record decides all of this, never whether the order
 * has recorded a PaymentIntent. Stripe mints the intent at checkout on
 * current API versions but with the session on older ones (as the
 * in-process stub does), and an intent Stripe cancels before any hold is
 * never recorded on the order. So G1 reads every state both ways.
 *
 *   G1  OrderPaymentCard on a PAYMENT_PENDING order with a link, in every
 *       authorization state, with and without a recorded PaymentIntent,
 *       with ORDER_REGENERATE_LINK and without: the share block (its
 *       heading and URL, "Copy link", "Open in new tab", "Regenerate
 *       link") and the "Generate a new payment link" button. Also a link
 *       released before checkout, CANCELLED with nothing ever authorized.
 *   G2  The other payment states. A spent hold on a LINK_GENERATED order
 *       gets the button too, as do a checkout declined before any hold and
 *       the FAILED and EXPIRED automatic orders, which keep theirs. Any
 *       other LINK_GENERATED order is offered no link at all, as before.
 *   G3  "Generate a new payment link" on a spent hold IS the regenerate
 *       action: it posts the regenerate route and reports what it answers.
 *   G4  OrderDetailPageContent: the "Payment in progress" banner that
 *       offers to re-send the payment request is shown for automatic
 *       orders in flight and before checkout, hidden for every later
 *       authorization state whatever the payment status says, for every
 *       role. Beside it, every control the page's payment card offers that
 *       role, so a live hold is never offered alongside a link.
 *   G5  OrderPaymentCard on a FAILED or an EXPIRED order, automatic or in
 *       every authorization state but CAPTURED (which settles the payment),
 *       handed every permission or ORDER_REGENERATE_LINK alone: a hold that
 *       stands keeps Capture / Retry capture / Release as on a
 *       PAYMENT_PENDING order and is never offered a new link; with no hold,
 *       or a spent one, the new link stays. A PAID order whose record still
 *       says AUTHORIZED, CAPTURE_PENDING or CAPTURE_FAILED offers nothing at
 *       all.
 *   G6  OrderDetailPageContent: the Archive button. Withheld while a hold
 *       stands, whatever the payment status; offered as before for automatic
 *       orders, before checkout and once the hold is spent, to every role
 *       holding ORDER_ARCHIVE, and never to one without it.
 *   G7  PaymentStatusFloater: a hold that stands outranks a FAILED or an
 *       EXPIRED payment status, so the banner reads the hold, never "Payment
 *       failed"; without one the status reads as before, and a PAID order
 *       reads "Payment received", captured or with its record still reading
 *       the hold.
 *   G8  OrderDetailPageContent's payment card on a PAID order, for every
 *       role: SUPER_ADMIN and ADMIN, handed every permission it gates on,
 *       and STAFF, handed a new link but no capture or release. A record
 *       still reading PENDING_AUTHORIZATION (with and without a recorded
 *       PaymentIntent), AUTHORIZED, CAPTURE_PENDING or CAPTURE_FAILED reads
 *       as captured, whoever looks (the Authorization panel is shown to
 *       every role): the line under the card's title, the Authorization
 *       badge and the sentence under it, none of them still reading the
 *       record's own state. No control at all: no Capture, Retry capture or
 *       Release (not even the release offered before checkout once an
 *       intent is recorded), no Regenerate, no Generate, no old link. A
 *       record reading CANCELLED or AUTHORIZATION_EXPIRED is offered no new
 *       link either, not even to STAFF. Beside each, the same order before
 *       it was paid (PAYMENT_PENDING) reads its record as itself and keeps
 *       the controls that role is offered, so the PAID status is what
 *       changes them.
 *
 * The page is fed the order directly (the order query is mocked) and its
 * reconcile, live feed and capture mutations are switched off; the evidence
 * and consent cards, which fetch their own data and play no part here, are
 * stubbed. G7 renders the floater on its own, with the same silent feed.
 * Every test ends by checking that the unit setup's fetch fence was never
 * called. G3 emulates the order API instead.
 */

/* ------------------------------------------------------------------ *
 * Mocks: no router, toasts, mutations, live feed or fetching
 * ------------------------------------------------------------------ */

const ROUTER = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ROUTER,
  usePathname: () => "/app/orders",
  useSearchParams: () => new URLSearchParams(),
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: toasts,
  Toaster: () => null,
}));

/** The capture and release dialogs only show their triggers here. */
vi.mock("@/hooks/use-capture-payment", () => ({
  useCapturePayment: () => ({ run: async () => undefined, isPending: false, error: null }),
  useReleaseAuthorization: () => ({ run: async () => undefined, isPending: false, error: null }),
}));

/** What GET /api/orders/[id] answered: the order page renders from it. */
const loaded = vi.hoisted(() => ({ order: null as OrderDTO | null }));

vi.mock("@/hooks/use-order-query", () => ({
  orderQueryKey: (orderId: string) => ["order", orderId] as const,
  useOrderQuery: () => ({
    data: loaded.order ?? undefined,
    error: null,
    isLoading: false,
  }),
}));

/** The page's self-healing reconcile would post 2.5 s after it opens. */
vi.mock("@/hooks/use-reconcile-payment", () => ({
  useReconcilePayment: () => ({
    trigger: () => {},
    isReconciling: false,
    lastResult: null,
    error: null,
  }),
}));

/** No live events: the status floater renders from the order alone. */
const FEED = vi.hoisted(() => ({
  events: [] as unknown[],
  push: () => {},
  clear: () => {},
}));

vi.mock("@/hooks/use-activity-feed", () => ({
  useActivityFeed: () => FEED,
}));

vi.mock("@/components/features/orders/order-evidence-card", () => ({
  OrderEvidenceCard: () => null,
}));

vi.mock("@/components/features/orders/order-consent-card", () => ({
  OrderConsentCard: () => null,
}));

/** The unit setup's fetch fence, put back after G3 emulates the API. */
const FENCE = globalThis.fetch;

beforeAll(() => {
  // The fence is the setup's mock, so "never called" below means something.
  expect(vi.isMockFunction(FENCE)).toBe(true);
});

afterEach(() => {
  // Unmount first: a failing hook skips the hooks after it, and the setup's
  // own cleanup must not be one of them, or the next test inherits this DOM.
  cleanup();
  vi.stubGlobal("fetch", FENCE);
  loaded.order = null;
  expect(FENCE).not.toHaveBeenCalled();
});

/* ------------------------------------------------------------------ *
 * The order: a car rental, as the order API serves it
 * ------------------------------------------------------------------ */

const ORDER_ID = "665f1c2b9d3e4a00123456c7";
const ORDER_NUMBER = "RC-24130";
const RENTAL_COST = 249.99;
const SESSION_ID = "cs_test_a1LinkGatingCamry";
const PAYMENT_URL = `https://checkout.stripe.test/c/pay/${SESSION_ID}`;
const INTENT_ID = "pi_test_3LinkGatingCamry";

const AUTHORIZED_AT = "2026-10-01T10:00:00.000Z";
const CAPTURE_DEADLINE = "2026-10-08T10:00:00.000Z";
const CAPTURED_AT = "2026-10-02T12:00:00.000Z";
const RELEASED_AT = "2026-10-02T12:30:00.000Z";
/** The gateway's reason for a declined checkout, as the webhook stores it. */
const DECLINE = "Your card was declined.";

const CHARGES: OrderCharge[] = [
  { name: "Rental cost", amount: RENTAL_COST, timing: PaymentTiming.PREPAID },
  { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
];

/** An automatic-capture car order whose link went out: `payment.capture`
 *  is null and there is no booking status. */
function carOrder(): OrderDTO {
  return {
    id: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    bookingType: BookingType.NEW_BOOKING,
    serviceType: ServiceType.CAR_RENTAL,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    bookingStatus: null,
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550100" },
    provider: {
      id: "BUDGET",
      name: "Budget",
      logo: "/providers/budget.png",
      primaryColor: "#000000",
      onPrimaryColor: "#FFFFFF",
    },
    vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
    trip: {
      pickupDate: "2026-10-17T15:00:00.000Z",
      dropoffDate: "2026-10-20T09:30:00.000Z",
      pickupLocation: "LAX Airport — Terminal 1",
      dropoffLocation: "San Diego Downtown",
    },
    flight: null,
    hotel: null,
    pricing: { amount: RENTAL_COST, currency: Currency.USD },
    charges: CHARGES,
    confirmationNumber: null,
    terms: { text: "Rental terms.", version: "v1" },
    termsAcknowledgement: null,
    payment: {
      gateway: PaymentGatewayKey.STRIPE,
      paymentSessionId: SESSION_ID,
      paymentUrl: PAYMENT_URL,
      // A Checkout Session carries no PaymentIntent until the customer pays.
      paymentIntentId: null,
      status: OrderStatus.PAYMENT_PENDING,
      paidAt: null,
      expiresAt: "2026-10-03T09:05:00.000Z",
      amountReceived: null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: "2026-10-01T09:05:00.000Z",
      capture: null,
    },
    createdBy: {
      userId: "665f1c2b9d3e4a00000000aa",
      name: "Olivia Operator",
      email: "olivia@payops.test",
    },
    policy: { acceptedAt: "2026-10-01T09:00:00.000Z", version: "v1", text: "Policy." },
    risk: { flagged: false },
    consent: {
      status: ConsentStatus.NOT_REQUESTED,
      currentConsentId: null,
      requestedAt: null,
      receivedAt: null,
      verifiedAt: null,
      method: null,
    },
    dispute: null,
    refundedAmount: 0,
    notes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  };
}

/** The booking status each authorization state carries beside it. */
const BOOKING_FOR: Record<PaymentCaptureStatus, BookingStatus> = {
  PENDING_AUTHORIZATION: BookingStatus.PENDING,
  AUTHORIZED: BookingStatus.PENDING,
  CAPTURE_PENDING: BookingStatus.PENDING,
  CAPTURE_FAILED: BookingStatus.PENDING,
  CAPTURED: BookingStatus.CONFIRMED,
  CANCELLED: BookingStatus.CANCELLED,
  AUTHORIZATION_EXPIRED: BookingStatus.CANCELLED,
};

/** The `payment.capture` record the server holds in `status`. */
function hold(status: PaymentCaptureStatus): OrderPaymentCapture {
  const authorized = status !== PaymentCaptureStatus.PENDING_AUTHORIZATION;
  const captured = status === PaymentCaptureStatus.CAPTURED;
  const released =
    status === PaymentCaptureStatus.CANCELLED ||
    status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED;
  return {
    method: CaptureMode.MANUAL,
    status,
    authorizedAt: authorized ? AUTHORIZED_AT : null,
    amountAuthorized: authorized ? RENTAL_COST : null,
    captureExpiresAt: authorized ? CAPTURE_DEADLINE : null,
    capturedAt: captured ? CAPTURED_AT : null,
    amountCaptured: captured ? RENTAL_COST : null,
    cancelledAt: released ? RELEASED_AT : null,
    cancelReason:
      status === PaymentCaptureStatus.CANCELLED
        ? "Supplier could not confirm"
        : status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED
          ? "automatic"
          : null,
    lastError:
      status === PaymentCaptureStatus.CAPTURE_FAILED
        ? "An error occurred with our connection to Stripe."
        : null,
  };
}

/** The car order on manual capture, in `status`. Only a capture settles
 *  the payment (PAID); every other state leaves it PAYMENT_PENDING. */
function heldOrder(status: PaymentCaptureStatus): OrderDTO {
  const order = carOrder();
  const captured = status === PaymentCaptureStatus.CAPTURED;
  const paymentStatus = captured ? OrderStatus.PAID : OrderStatus.PAYMENT_PENDING;
  return {
    ...order,
    status: paymentStatus,
    bookingStatus: BOOKING_FOR[status],
    payment: {
      ...order.payment,
      status: paymentStatus,
      paymentIntentId:
        status === PaymentCaptureStatus.PENDING_AUTHORIZATION ? null : INTENT_ID,
      paidAt: captured ? CAPTURED_AT : null,
      amountReceived: captured ? RENTAL_COST : null,
      capture: hold(status),
    },
  };
}

/** A PAYMENT_PENDING order with its link out: automatic when `capture`
 *  is null, otherwise on manual capture in that state. */
function pendingOrder(capture: PaymentCaptureStatus | null): OrderDTO {
  return capture === null ? carOrder() : heldOrder(capture);
}

/** `order` in payment status `status`. A FAILED one carries the decline. */
function inStatus(order: OrderDTO, status: OrderStatus): OrderDTO {
  return {
    ...order,
    status,
    payment: {
      ...order.payment,
      status,
      failureReason: status === OrderStatus.FAILED ? DECLINE : null,
    },
  };
}

/** A manual-capture checkout declined before any hold: the decline fails
 *  the order and leaves the authorization record awaiting its hold. */
function declinedOrder(): OrderDTO {
  return inStatus(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), OrderStatus.FAILED);
}

/** …after which Stripe cancelled the declined intent, still the order's
 *  current one: the record is CANCELLED although no hold ever stood. */
function declinedThenCancelledOrder(): OrderDTO {
  const order = declinedOrder();
  return {
    ...order,
    bookingStatus: BookingStatus.CANCELLED,
    payment: {
      ...order.payment,
      capture: {
        ...order.payment.capture!,
        status: PaymentCaptureStatus.CANCELLED,
        cancelledAt: RELEASED_AT,
      },
    },
  };
}

/** …or the customer then authorized another card on the same checkout. The
 *  authorization moves such an order back to PAYMENT_PENDING, but one it
 *  did not move (a decline written in the same moment, an order authorized
 *  before that recovery existed) has a live hold standing on a FAILED
 *  order, and every surface must read the hold. */
function declinedThenAuthorizedOrder(): OrderDTO {
  const order = declinedOrder();
  return {
    ...order,
    payment: {
      ...order.payment,
      paymentIntentId: INTENT_ID,
      capture: hold(PaymentCaptureStatus.AUTHORIZED),
    },
  };
}

/** The authorization states in which a hold stands on the card. */
const LIVE_HOLDS = [
  PaymentCaptureStatus.AUTHORIZED,
  PaymentCaptureStatus.CAPTURE_PENDING,
  PaymentCaptureStatus.CAPTURE_FAILED,
] as const;
type LiveHold = (typeof LIVE_HOLDS)[number];

/** The payment states G6 and G7 read a live hold beside: the
 *  PAYMENT_PENDING it normally stands on, then FAILED and EXPIRED. */
const BESIDE_A_HOLD = [OrderStatus.PAYMENT_PENDING, OrderStatus.FAILED, OrderStatus.EXPIRED];

/** `order` with its payment settled (PAID) and its authorization record,
 *  booking status and recorded PaymentIntent left exactly as they were. */
function paid(order: OrderDTO): OrderDTO {
  return {
    ...order,
    status: OrderStatus.PAID,
    payment: {
      ...order.payment,
      status: OrderStatus.PAID,
      paidAt: CAPTURED_AT,
      amountReceived: RENTAL_COST,
    },
  };
}

/** The payment settled before the authorization record caught up: a capture
 *  settles the payment first and records CAPTURED in a second write, and a
 *  reconcile can land the money while the record still reads the hold. */
function paidAheadOfRecord(status: LiveHold): OrderDTO {
  return paid(heldOrder(status));
}

/** `order` with `paymentIntentId` as the PaymentIntent it has recorded. */
function withIntent(order: OrderDTO, paymentIntentId: string | null): OrderDTO {
  return { ...order, payment: { ...order.payment, paymentIntentId } };
}

/** A link whose intent the operator released before the customer checked
 *  out (the card offers "Release hold" once an intent exists): CANCELLED
 *  with nothing ever authorized, and the payment still pending. */
function releasedBeforeCheckoutOrder(): OrderDTO {
  const order = withIntent(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), INTENT_ID);
  return {
    ...order,
    bookingStatus: BookingStatus.CANCELLED,
    payment: {
      ...order.payment,
      capture: {
        ...hold(PaymentCaptureStatus.CANCELLED),
        authorizedAt: null,
        amountAuthorized: null,
        captureExpiresAt: null,
      },
    },
  };
}

/** Recorded or not, the PaymentIntent must not change what the card
 *  offers (see the header). */
const INTENT_RECORDED = [
  { intent: null, recorded: "no PaymentIntent recorded" },
  { intent: INTENT_ID, recorded: "PaymentIntent recorded" },
];

/** `order` with `payment.capture` set to `value`, or removed outright. */
function withCapture(order: OrderDTO, value: null | undefined | "absent"): OrderDTO {
  const payment: Partial<OrderDTO["payment"]> = { ...order.payment };
  if (value === "absent") delete payment.capture;
  else payment.capture = value;
  return { ...order, payment: payment as OrderDTO["payment"] };
}

/* ------------------------------------------------------------------ *
 * Reading the card and the page
 * ------------------------------------------------------------------ */

const SHARE_HEADING = "Payment link to share with the customer";
const GENERATE = "Generate a new payment link";
/** The share block's controls, in order. */
const SHARE = ["Copy link", "Open in new tab", "Regenerate link"];
const SHARE_WITHOUT_REGENERATE = ["Copy link", "Open in new tab"];

/** Every control in `scope`, buttons and links, by its text, in order. */
function controls(scope: ParentNode): string[] {
  return Array.from(scope.querySelectorAll("button, a")).map((el) => el.textContent ?? "");
}

/** The share block's heading and the URL printed under it, or null. */
function shareBlock(scope: HTMLElement): [string, string] | null {
  const heading = within(scope).queryByText(SHARE_HEADING);
  return heading
    ? [heading.textContent ?? "", heading.nextElementSibling?.textContent ?? ""]
    : null;
}

/** Nothing in `scope` hands out the old link: no share heading, no URL
 *  printed, nothing pointing at it. */
function expectNoOldLink(scope: HTMLElement) {
  expect(shareBlock(scope)).toBeNull();
  expect(scope.textContent).not.toContain(PAYMENT_URL);
  expect(scope.querySelector(`[href="${PAYMENT_URL}"]`)).toBeNull();
}

/** The share block, complete: heading, URL, and a link opening the URL. */
function expectOldLinkShared(scope: HTMLElement) {
  expect(shareBlock(scope)).toEqual([SHARE_HEADING, PAYMENT_URL]);
  const open = within(scope).getByRole("link", { name: "Open in new tab" });
  expect(open).toHaveAttribute("href", PAYMENT_URL);
  expect(open).toHaveAttribute("target", "_blank");
}

/* ------------------------------------------------------------------ *
 * G1: a PAYMENT_PENDING order, in every authorization state
 * ------------------------------------------------------------------ */

interface PendingRow {
  /** null: an automatic-capture order. */
  capture: PaymentCaptureStatus | null;
  /** What the state means for the link, in the test's title. */
  reads: string;
  /** Whether the share block (heading, URL and its controls) is shown. */
  share: boolean;
  /** Every control on the card with ORDER_REGENERATE_LINK, in order. */
  withRegenerate: string[];
  /** …and without it. */
  withoutRegenerate: string[];
}

const LIVE_LINK = "the link is live";
const LIVE_HOLD = "a live hold: no link, old or new";
const SPENT_HOLD = "a spent hold: only a new link";

const ON_A_PENDING_ORDER: PendingRow[] = [
  {
    capture: null,
    reads: LIVE_LINK,
    share: true,
    withRegenerate: SHARE,
    withoutRegenerate: SHARE_WITHOUT_REGENERATE,
  },
  {
    capture: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    reads: LIVE_LINK,
    share: true,
    withRegenerate: SHARE,
    withoutRegenerate: SHARE_WITHOUT_REGENERATE,
  },
  {
    capture: PaymentCaptureStatus.AUTHORIZED,
    reads: LIVE_HOLD,
    share: false,
    withRegenerate: [],
    withoutRegenerate: [],
  },
  {
    capture: PaymentCaptureStatus.CAPTURE_PENDING,
    reads: LIVE_HOLD,
    share: false,
    withRegenerate: [],
    withoutRegenerate: [],
  },
  {
    capture: PaymentCaptureStatus.CAPTURE_FAILED,
    reads: LIVE_HOLD,
    share: false,
    withRegenerate: [],
    withoutRegenerate: [],
  },
  {
    capture: PaymentCaptureStatus.CANCELLED,
    reads: SPENT_HOLD,
    share: false,
    withRegenerate: [GENERATE],
    withoutRegenerate: [],
  },
  {
    capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
    reads: SPENT_HOLD,
    share: false,
    withRegenerate: [GENERATE],
    withoutRegenerate: [],
  },
];

describe("G1 — OrderPaymentCard on a PAYMENT_PENDING order with a link, in every authorization state, with or without a recorded PaymentIntent", () => {
  it("the table covers every authorization state a PAYMENT_PENDING order can hold (all but CAPTURED, which settles the payment)", () => {
    expect(
      ON_A_PENDING_ORDER.flatMap((row) => (row.capture ? [row.capture] : [])).sort(),
    ).toEqual(
      PAYMENT_CAPTURE_STATUSES.filter((s) => s !== PaymentCaptureStatus.CAPTURED).sort(),
    );
  });

  it.each(
    ON_A_PENDING_ORDER.flatMap((row) =>
      [true, false].flatMap((canRegenerate) =>
        INTENT_RECORDED.map(({ intent, recorded }) => ({
          ...row,
          label: row.capture ?? "automatic (capture null)",
          canRegenerate,
          intent,
          recorded,
        })),
      ),
    ),
  )(
    "$label, $recorded, canRegenerate $canRegenerate: $reads",
    ({ capture, share, withRegenerate, withoutRegenerate, canRegenerate, intent }) => {
      const { container } = render(
        <OrderPaymentCard
          order={withIntent(pendingOrder(capture), intent)}
          canRegenerate={canRegenerate}
        />,
      );

      expect(controls(container)).toEqual(canRegenerate ? withRegenerate : withoutRegenerate);
      if (share) expectOldLinkShared(container);
      else expectNoOldLink(container);
    },
  );

  it.each([true, false])(
    "CANCELLED before anything was authorized (released before checkout), canRegenerate %s: the link is spent all the same, only a new one",
    (canRegenerate) => {
      const { container } = render(
        <OrderPaymentCard order={releasedBeforeCheckoutOrder()} canRegenerate={canRegenerate} />,
      );

      expect(controls(container)).toEqual(canRegenerate ? [GENERATE] : []);
      expectNoOldLink(container);
    },
  );
});

/* ------------------------------------------------------------------ *
 * G2: the other payment states
 * ------------------------------------------------------------------ */

interface OrderCase {
  name: string;
  build: () => OrderDTO;
}

/** Orders that only a NEW link can collect on. */
const NEW_LINK_ONLY: OrderCase[] = [
  {
    name: "LINK_GENERATED, hold released",
    build: () => inStatus(heldOrder(PaymentCaptureStatus.CANCELLED), OrderStatus.LINK_GENERATED),
  },
  {
    name: "LINK_GENERATED, hold expired",
    build: () =>
      inStatus(heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED), OrderStatus.LINK_GENERATED),
  },
  {
    name: "FAILED, automatic",
    build: () => inStatus(carOrder(), OrderStatus.FAILED),
  },
  {
    name: "EXPIRED, automatic",
    build: () => inStatus(carOrder(), OrderStatus.EXPIRED),
  },
  {
    name: "FAILED at checkout, before any hold",
    build: declinedOrder,
  },
  // A failed checkout and a spent hold both call for a new link: one
  // button, not two.
  {
    name: "FAILED, then its intent CANCELLED",
    build: declinedThenCancelledOrder,
  },
];

/** The contrast: a LINK_GENERATED order whose link is not spent has never
 *  been offered a link on this card, whatever its authorization. */
const NO_LINK: OrderCase[] = [
  {
    name: "LINK_GENERATED, automatic",
    build: () => inStatus(carOrder(), OrderStatus.LINK_GENERATED),
  },
  {
    name: "LINK_GENERATED, awaiting its hold",
    build: () =>
      inStatus(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), OrderStatus.LINK_GENERATED),
  },
  {
    name: "LINK_GENERATED, hold live",
    build: () => inStatus(heldOrder(PaymentCaptureStatus.AUTHORIZED), OrderStatus.LINK_GENERATED),
  },
];

describe("G2 — OrderPaymentCard in the other payment states", () => {
  it.each(NEW_LINK_ONLY)(
    "$name: 'Generate a new payment link' with ORDER_REGENERATE_LINK, nothing without it, never the old link",
    ({ build }) => {
      const order = build();

      const allowed = render(<OrderPaymentCard order={order} canRegenerate />);
      expect(controls(allowed.container)).toEqual([GENERATE]);
      expectNoOldLink(allowed.container);
      allowed.unmount();

      const denied = render(<OrderPaymentCard order={order} canRegenerate={false} />);
      expect(controls(denied.container)).toEqual([]);
      expectNoOldLink(denied.container);
    },
  );

  it.each(NO_LINK)("$name: no link control at all, old or new", ({ build }) => {
    const { container } = render(<OrderPaymentCard order={build()} canRegenerate />);

    expect(controls(container)).toEqual([]);
    expectNoOldLink(container);
  });
});

/* ------------------------------------------------------------------ *
 * G3: "Generate a new payment link" on a spent hold
 * ------------------------------------------------------------------ */

describe("G3 — 'Generate a new payment link' on a spent hold asks the server for a new link", () => {
  const REGENERATE_URL = `/api/orders/${ORDER_ID}/regenerate-link`;
  /** What the server answers when the order changed under the page: the
   *  link was regenerated elsewhere and the customer authorized it. */
  const LIVE_AUTHORIZATION =
    "This order has a live authorization. Release the authorization before generating a new payment link.";

  let requests: string[] = [];

  /** The regenerate route, answering `status` with `payload`. */
  function serve(status: number, payload: unknown) {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        requests.push(`${init.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("a released hold: posts the regenerate route once, toasts 'New payment link generated' and refreshes the page", async () => {
    const rearmed = heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    serve(200, { ok: true, data: { order: rearmed, checkoutUrl: rearmed.payment.paymentUrl } });
    render(<OrderPaymentCard order={heldOrder(PaymentCaptureStatus.CANCELLED)} canRegenerate />);

    fireEvent.click(screen.getByRole("button", { name: GENERATE }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("New payment link generated"));
    expect(requests).toEqual([`POST ${REGENERATE_URL}`]);
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(ROUTER.refresh).toHaveBeenCalledTimes(1);
  });

  it("an expired hold: a refusal is toasted word for word, the page is not refreshed, and the button can be pressed again", async () => {
    serve(409, { ok: false, error: { code: "CONFLICT", message: LIVE_AUTHORIZATION } });
    render(
      <OrderPaymentCard
        order={heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED)}
        canRegenerate
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: GENERATE }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(LIVE_AUTHORIZATION));
    expect(requests).toEqual([`POST ${REGENERATE_URL}`]);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(ROUTER.refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: GENERATE })).toBeEnabled());
  });
});

/* ------------------------------------------------------------------ *
 * G4: the order page's "Payment in progress" banner
 * ------------------------------------------------------------------ */

const ROLES = [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF];

const BANNER_TEXT =
  "Re-send the payment-request email or edit customer details from the email composer.";

/** The order page as `/orders/[id]` mounts it for `role`, on `order`. */
function renderPage(order: OrderDTO, role: UserRole) {
  loaded.order = order;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OrderDetailPageContent orderId={order.id} role={role} />
    </QueryClientProvider>,
  );
}

/** The "Payment in progress" banner, or null when the page has none. */
function resendBanner(): HTMLElement | null {
  const title = screen.queryByText("Payment in progress", { selector: "h5" });
  return title?.closest<HTMLElement>('[role="alert"]') ?? null;
}

function expectResendBanner() {
  const banner = resendBanner();
  expect(banner).not.toBeNull();
  expect(within(banner!).getByText(BANNER_TEXT)).toBeInTheDocument();
  expect(within(banner!).getByRole("link", { name: "Edit payment email" })).toHaveAttribute(
    "href",
    `/app/orders/${ORDER_ID}/email`,
  );
}

function expectNoResendBanner() {
  expect(resendBanner()).toBeNull();
  expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  expect(screen.queryByRole("link", { name: "Edit payment email" })).toBeNull();
}

/** The page's money card. */
function paymentCard(): HTMLElement {
  const title = screen.getByRole("heading", { level: 3, name: "Payment" });
  const card = title.closest<HTMLElement>('[data-slot="card"]');
  expect(card).not.toBeNull();
  return card!;
}

interface PageRow extends OrderCase {
  /** Every control on the payment card for SUPER_ADMIN and ADMIN. */
  admin: string[];
  /** …for STAFF, who may regenerate a link but not capture or release. */
  staff: string[];
}

/** In flight, with a payment request still worth re-sending. */
const BANNER_SHOWN: PageRow[] = [
  {
    name: "automatic, awaiting payment",
    build: carOrder,
    admin: SHARE,
    staff: SHARE,
  },
  {
    name: "automatic, FAILED at checkout",
    build: () => inStatus(carOrder(), OrderStatus.FAILED),
    admin: [GENERATE],
    staff: [GENERATE],
  },
  {
    name: "automatic, link EXPIRED",
    build: () => inStatus(carOrder(), OrderStatus.EXPIRED),
    admin: [GENERATE],
    staff: [GENERATE],
  },
  {
    name: "PENDING_AUTHORIZATION, before checkout",
    build: () => heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION),
    admin: SHARE,
    staff: SHARE,
  },
  // Its intent was minted with the session: still before checkout, so the
  // request is still worth re-sending. The card also offers to release it.
  {
    name: "PENDING_AUTHORIZATION, intent recorded",
    build: () => withIntent(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), INTENT_ID),
    admin: ["Release hold", ...SHARE],
    staff: SHARE,
  },
  {
    name: "FAILED at checkout, before any hold",
    build: declinedOrder,
    admin: [GENERATE],
    staff: [GENERATE],
  },
];

/** Past checkout: nothing left to ask the customer for. */
const BANNER_HIDDEN: PageRow[] = [
  {
    name: "AUTHORIZED",
    build: () => heldOrder(PaymentCaptureStatus.AUTHORIZED),
    admin: ["Capture payment", "Release hold"],
    staff: [],
  },
  {
    name: "CAPTURE_PENDING",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURE_PENDING),
    admin: [],
    staff: [],
  },
  {
    name: "CAPTURE_FAILED",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURE_FAILED),
    admin: ["Retry capture", "Release hold"],
    staff: [],
  },
  {
    name: "CANCELLED",
    build: () => heldOrder(PaymentCaptureStatus.CANCELLED),
    admin: [GENERATE],
    staff: [GENERATE],
  },
  {
    name: "AUTHORIZATION_EXPIRED",
    build: () => heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED),
    admin: [GENERATE],
    staff: [GENERATE],
  },
  // A failed checkout keeps the banner (above); the spent record hides it.
  {
    name: "FAILED, then its intent CANCELLED",
    build: declinedThenCancelledOrder,
    admin: [GENERATE],
    staff: [GENERATE],
  },
  // …and so does a live one, which the card captures or releases exactly
  // as on a PAYMENT_PENDING order and never offers to replace.
  {
    name: "FAILED, then another card AUTHORIZED",
    build: declinedThenAuthorizedOrder,
    admin: ["Capture payment", "Release hold"],
    staff: [],
  },
  {
    name: "CAPTURED (PAID)",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURED),
    admin: [],
    staff: [],
  },
];

function forEveryRole<Row extends object>(rows: Row[], roles: UserRole[] = ROLES) {
  return rows.flatMap((row) => roles.map((role) => ({ ...row, role })));
}

/** The page rendered the order, not its skeleton or an error. */
function expectOrderPage() {
  expect(screen.getByRole("heading", { level: 1, name: ORDER_NUMBER })).toBeInTheDocument();
}

describe("G4 — OrderDetailPageContent: the 'Payment in progress' re-send banner", () => {
  it("the tables cover every PaymentCaptureStatus, and automatic orders", () => {
    const states = [...BANNER_SHOWN, ...BANNER_HIDDEN].map(
      (row) => row.build().payment.capture?.status ?? null,
    );
    expect(states).toContain(null);
    expect([...new Set(states.flatMap((s) => (s ? [s] : [])))].sort()).toEqual(
      [...PAYMENT_CAPTURE_STATUSES].sort(),
    );
  });

  it.each(forEveryRole(BANNER_SHOWN))(
    "$name as $role: the banner offers to re-send the request; every control on the payment card",
    ({ build, admin, staff, role }) => {
      renderPage(build(), role);

      expectOrderPage();
      expectResendBanner();
      expect(controls(paymentCard())).toEqual(role === UserRole.STAFF ? staff : admin);
    },
  );

  it.each(forEveryRole(BANNER_HIDDEN))(
    "$name as $role: no re-send banner; every control on the payment card",
    ({ build, admin, staff, role }) => {
      renderPage(build(), role);

      expectOrderPage();
      expectNoResendBanner();
      expect(controls(paymentCard())).toEqual(role === UserRole.STAFF ? staff : admin);
    },
  );

  it.each([null, undefined, "absent"] as const)(
    "an automatic order in flight keeps the banner whether capture is %s",
    (value) => {
      renderPage(withCapture(carOrder(), value), UserRole.ADMIN);

      expectResendBanner();
      expect(controls(paymentCard())).toEqual(SHARE);
    },
  );
});

/* ------------------------------------------------------------------ *
 * G5: a FAILED, EXPIRED or PAID order with an authorization record
 * ------------------------------------------------------------------ */

interface FailedOrExpiredRow {
  /** null: an automatic-capture order. */
  capture: PaymentCaptureStatus | null;
  /** What the state means for the card, in the test's title. */
  reads: string;
  /** Every control on the card handed every permission, in order. */
  everyPermission: string[];
  /** …handed ORDER_REGENERATE_LINK alone. */
  regenerateOnly: string[];
}

/** What the card is handed: every permission, as ADMIN and SUPER_ADMIN
 *  are, or ORDER_REGENERATE_LINK alone, as STAFF is. */
const HANDED = [
  {
    handed: "every permission",
    props: { canRegenerate: true, canCapture: true, canRelease: true },
    offered: (row: FailedOrExpiredRow) => row.everyPermission,
  },
  {
    handed: "ORDER_REGENERATE_LINK alone",
    props: { canRegenerate: true, canCapture: false, canRelease: false },
    offered: (row: FailedOrExpiredRow) => row.regenerateOnly,
  },
];

const NO_HOLD = "no hold: only a new link";

/** A hold that stands is offered what G4 shows beside it on a
 *  PAYMENT_PENDING order (Capture or Retry capture, and Release, with every
 *  permission; nothing while a capture is in flight, or with
 *  ORDER_REGENERATE_LINK alone) and never a link, old or new. */
const ON_A_FAILED_OR_EXPIRED_ORDER: FailedOrExpiredRow[] = [
  {
    capture: null,
    reads: NO_HOLD,
    everyPermission: [GENERATE],
    regenerateOnly: [GENERATE],
  },
  {
    capture: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    reads: NO_HOLD,
    everyPermission: [GENERATE],
    regenerateOnly: [GENERATE],
  },
  {
    capture: PaymentCaptureStatus.AUTHORIZED,
    reads: LIVE_HOLD,
    everyPermission: ["Capture payment", "Release hold"],
    regenerateOnly: [],
  },
  {
    capture: PaymentCaptureStatus.CAPTURE_PENDING,
    reads: LIVE_HOLD,
    everyPermission: [],
    regenerateOnly: [],
  },
  {
    capture: PaymentCaptureStatus.CAPTURE_FAILED,
    reads: LIVE_HOLD,
    everyPermission: ["Retry capture", "Release hold"],
    regenerateOnly: [],
  },
  {
    capture: PaymentCaptureStatus.CANCELLED,
    reads: SPENT_HOLD,
    everyPermission: [GENERATE],
    regenerateOnly: [GENERATE],
  },
  {
    capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
    reads: SPENT_HOLD,
    everyPermission: [GENERATE],
    regenerateOnly: [GENERATE],
  },
];

describe("G5 — OrderPaymentCard on a FAILED, EXPIRED or PAID order, handed every permission or ORDER_REGENERATE_LINK alone", () => {
  it("the table covers every authorization state but CAPTURED (which settles the payment), and automatic orders", () => {
    const states = ON_A_FAILED_OR_EXPIRED_ORDER.map((row) => row.capture);
    expect(states).toContain(null);
    expect(states.flatMap((s) => (s ? [s] : [])).sort()).toEqual(
      PAYMENT_CAPTURE_STATUSES.filter((s) => s !== PaymentCaptureStatus.CAPTURED).sort(),
    );
  });

  it.each(
    ON_A_FAILED_OR_EXPIRED_ORDER.flatMap((row) =>
      [OrderStatus.FAILED, OrderStatus.EXPIRED].flatMap((status) =>
        HANDED.map(({ handed, props, offered }) => ({
          ...row,
          label: row.capture ?? "automatic (capture null)",
          status,
          handed,
          props,
          expected: offered(row),
        })),
      ),
    ),
  )("$status, $label, handed $handed: $reads", ({ capture, status, props, expected }) => {
    const { container } = render(
      <OrderPaymentCard order={inStatus(pendingOrder(capture), status)} {...props} />,
    );

    expect(controls(container)).toEqual(expected);
    expectNoOldLink(container);
  });

  // Every permission is the most the card can be handed, so nothing offered
  // here means nothing offered with less.
  it.each(LIVE_HOLDS)(
    "PAID while the record still says %s, handed every permission: no Capture, no Release, no link, old or new",
    (status) => {
      const { container } = render(
        <OrderPaymentCard order={paidAheadOfRecord(status)} canRegenerate canCapture canRelease />,
      );

      expect(controls(container)).toEqual([]);
      expectNoOldLink(container);
    },
  );
});

/* ------------------------------------------------------------------ *
 * G6: the order page's Archive button
 * ------------------------------------------------------------------ */

/** The roles the permission matrix lets archive an order, and the rest. */
const ARCHIVERS = ROLES.filter((role) => roleHasPermission(role, Permission.ORDER_ARCHIVE));
const NOT_ARCHIVERS = ROLES.filter((role) => !ARCHIVERS.includes(role));

/** The page header's Archive button, or null when it offers none. */
function archiveButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Archive" });
}

/** No hold stands in the way: none was ever placed, or it is spent. */
const ARCHIVE_OFFERED: OrderCase[] = [
  {
    name: "automatic, awaiting payment",
    build: carOrder,
  },
  {
    name: "automatic, FAILED at checkout",
    build: () => inStatus(carOrder(), OrderStatus.FAILED),
  },
  {
    name: "automatic, link EXPIRED",
    build: () => inStatus(carOrder(), OrderStatus.EXPIRED),
  },
  {
    name: "PENDING_AUTHORIZATION, before checkout",
    build: () => heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION),
  },
  {
    name: "PENDING_AUTHORIZATION, intent recorded",
    build: () => withIntent(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), INTENT_ID),
  },
  {
    name: "FAILED at checkout, before any hold",
    build: declinedOrder,
  },
  {
    name: "CANCELLED",
    build: () => heldOrder(PaymentCaptureStatus.CANCELLED),
  },
  {
    name: "AUTHORIZATION_EXPIRED",
    build: () => heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED),
  },
  {
    name: "FAILED, then its intent CANCELLED",
    build: declinedThenCancelledOrder,
  },
];

/** A hold stands, whatever the payment status says; and, as always, a paid
 *  order. */
const ARCHIVE_WITHHELD: OrderCase[] = [
  ...LIVE_HOLDS.flatMap((capture) =>
    BESIDE_A_HOLD.map((status) => ({
      name: `${status}, ${capture} hold`,
      build: () => inStatus(heldOrder(capture), status),
    })),
  ),
  {
    name: "CAPTURED (PAID)",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURED),
  },
];

describe("G6 — OrderDetailPageContent: no Archive button while a hold stands", () => {
  it("every role is read, and ORDER_ARCHIVE is held by SUPER_ADMIN and ADMIN, not by STAFF", () => {
    // A role added later is read by G4 and here, not silently skipped.
    expect([...ROLES].sort()).toEqual([...USER_ROLES].sort());
    expect(ARCHIVERS).toEqual([UserRole.SUPER_ADMIN, UserRole.ADMIN]);
    expect(NOT_ARCHIVERS).toEqual([UserRole.STAFF]);
  });

  it("the tables cover every PaymentCaptureStatus, and automatic orders", () => {
    const states = [...ARCHIVE_OFFERED, ...ARCHIVE_WITHHELD].map(
      (row) => row.build().payment.capture?.status ?? null,
    );
    expect(states).toContain(null);
    expect([...new Set(states.flatMap((s) => (s ? [s] : [])))].sort()).toEqual(
      [...PAYMENT_CAPTURE_STATUSES].sort(),
    );
  });

  it.each(forEveryRole(ARCHIVE_OFFERED, ARCHIVERS))(
    "$name as $role: Archive is offered",
    ({ build, role }) => {
      renderPage(build(), role);

      expectOrderPage();
      expect(archiveButton()).toBeInTheDocument();
    },
  );

  it.each(forEveryRole(ARCHIVE_WITHHELD, ARCHIVERS))(
    "$name as $role: no Archive button",
    ({ build, role }) => {
      renderPage(build(), role);

      expectOrderPage();
      expect(archiveButton()).toBeNull();
    },
  );

  it.each(forEveryRole([...ARCHIVE_OFFERED, ...ARCHIVE_WITHHELD], NOT_ARCHIVERS))(
    "$name as $role, without ORDER_ARCHIVE: never an Archive button",
    ({ build, role }) => {
      renderPage(build(), role);

      expectOrderPage();
      expect(archiveButton()).toBeNull();
    },
  );
});

/* ------------------------------------------------------------------ *
 * G7: the live-status floater
 * ------------------------------------------------------------------ */

/** The floater's two lines: its label, then its detail. */
function floaterLines(): string[] {
  return Array.from(screen.getByRole("status").querySelectorAll("p")).map(
    (line) => line.textContent ?? "",
  );
}

/** What a hold that stands reads: the authorization's label, then what it
 *  means for the operator. */
const HOLD_LINES: Record<LiveHold, string[]> = {
  AUTHORIZED: [
    PaymentCaptureStatusLabel[PaymentCaptureStatus.AUTHORIZED],
    `The card is on hold and has not been charged. Capture by ${new Date(CAPTURE_DEADLINE).toLocaleString()} or the hold is released.`,
  ],
  CAPTURE_PENDING: [
    PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_PENDING],
    "Charging the authorized amount now.",
  ],
  CAPTURE_FAILED: [
    PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_FAILED],
    hold(PaymentCaptureStatus.CAPTURE_FAILED).lastError!,
  ],
};

const PAYMENT_FAILED = ["Payment failed", DECLINE];
const LINK_EXPIRED = [
  "Payment link expired",
  "The customer didn't complete checkout in time. Regenerate the link to try again.",
];
const PAYMENT_RECEIVED = [
  "Payment received",
  `Payment confirmed at ${new Date(CAPTURED_AT).toLocaleString()}.`,
];

interface FloaterRow extends OrderCase {
  /** The floater's label and detail. */
  lines: string[];
}

/** On a PAYMENT_PENDING order the hold has always read this way; beside a
 *  FAILED or an EXPIRED status it must read the same. */
const READS_THE_HOLD: FloaterRow[] = LIVE_HOLDS.flatMap((capture) =>
  BESIDE_A_HOLD.map((status) => ({
    name: `${status}, ${capture} hold`,
    build: () => inStatus(heldOrder(capture), status),
    lines: HOLD_LINES[capture],
  })),
);

/** No hold stands, or the payment settled: the status reads as before. */
const READS_THE_STATUS: FloaterRow[] = [
  {
    name: "FAILED, automatic",
    build: () => inStatus(carOrder(), OrderStatus.FAILED),
    lines: PAYMENT_FAILED,
  },
  {
    name: "FAILED at checkout, before any hold",
    build: declinedOrder,
    lines: PAYMENT_FAILED,
  },
  {
    name: "FAILED, then its intent CANCELLED",
    build: declinedThenCancelledOrder,
    lines: PAYMENT_FAILED,
  },
  {
    name: "FAILED, its hold since expired",
    build: () =>
      inStatus(heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED), OrderStatus.FAILED),
    lines: PAYMENT_FAILED,
  },
  {
    name: "EXPIRED, automatic",
    build: () => inStatus(carOrder(), OrderStatus.EXPIRED),
    lines: LINK_EXPIRED,
  },
  {
    name: "EXPIRED before checkout",
    build: () =>
      inStatus(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), OrderStatus.EXPIRED),
    lines: LINK_EXPIRED,
  },
  {
    name: "EXPIRED, hold released",
    build: () => inStatus(heldOrder(PaymentCaptureStatus.CANCELLED), OrderStatus.EXPIRED),
    lines: LINK_EXPIRED,
  },
  // The settled order those records below are catching up to.
  {
    name: "PAID, captured",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURED),
    lines: PAYMENT_RECEIVED,
  },
  ...LIVE_HOLDS.map((capture) => ({
    name: `PAID, record still ${capture}`,
    build: () => paidAheadOfRecord(capture),
    lines: PAYMENT_RECEIVED,
  })),
];

describe("G7 — PaymentStatusFloater: a hold that stands outranks a FAILED or EXPIRED payment status", () => {
  it.each(READS_THE_HOLD)("$name: reads the hold", ({ build, lines }) => {
    render(<PaymentStatusFloater order={build()} />);

    expect(floaterLines()).toEqual(lines);
  });

  it.each(READS_THE_STATUS)(
    "$name: reads the payment status, as before",
    ({ build, lines }) => {
      render(<PaymentStatusFloater order={build()} />);

      expect(floaterLines()).toEqual(lines);
    },
  );
});

/* ------------------------------------------------------------------ *
 * G8: a PAID order whose authorization record has not caught up
 * ------------------------------------------------------------------ */

/** The roles the permission matrix hands every control the payment card
 *  gates: a new link, a capture and a release. */
const CAPTURERS = ROLES.filter(
  (role) =>
    roleHasPermission(role, Permission.ORDER_REGENERATE_LINK) &&
    roleHasPermission(role, Permission.ORDER_CAPTURE_PAYMENT) &&
    roleHasPermission(role, Permission.ORDER_VOID_AUTHORIZATION),
);

/** The roles it hands a new link (ORDER_REGENERATE_LINK). */
const REGENERATORS = ROLES.filter((role) =>
  roleHasPermission(role, Permission.ORDER_REGENERATE_LINK),
);

/** How the payment card reads an authorization record: the line under its
 *  "Payment" title, the badge of its Authorization panel, and the sentence
 *  under that badge. */
interface Reading {
  description: string;
  badge: string;
  help: string;
}

/** The card's reading of the order's authorization record. */
function readingOf(card: HTMLElement): Reading {
  const title = within(card).getByText("Authorization", { selector: "p" });
  const row = title.parentElement!;
  return {
    description: card.querySelector('[data-slot="card-description"]')?.textContent ?? "",
    badge: row.querySelector('[data-slot="badge"]')?.textContent ?? "",
    help: row.nextElementSibling?.textContent ?? "",
  };
}

/** A capture whose time is not on the record yet: the write that would
 *  record it is the one that has not landed. */
const READS_CAPTURED: Reading = {
  description: "Captured",
  badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURED],
  help: "The money has been taken. Reversing it now means issuing a refund.",
};

const READS_AWAITING_AUTHORIZATION: Reading = {
  description: "Waiting for the customer to authorize their card",
  badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.PENDING_AUTHORIZATION],
  help: "No hold exists yet. Nothing can be captured until the customer completes checkout.",
};

interface RecordRow extends OrderCase {
  /** How the card reads the record before the order is paid, whoever looks. */
  reads: Reading;
  /** Every control the card then offers SUPER_ADMIN and ADMIN, in order. */
  admin: string[];
  /** …and STAFF, who may regenerate a link but not capture or release. */
  staff: string[];
}

/** The records a PAID order can still carry: the write that settles the
 *  record after the payment moves each of these, and only these, to
 *  CAPTURED (see `paidAheadOfRecord`). */
const LAGGING_RECORDS: RecordRow[] = [
  {
    name: "PENDING_AUTHORIZATION, no intent",
    build: () => heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION),
    reads: READS_AWAITING_AUTHORIZATION,
    admin: SHARE,
    staff: SHARE,
  },
  // Before checkout the card offers to release a recorded intent (G4).
  {
    name: "PENDING_AUTHORIZATION, intent recorded",
    build: () => withIntent(heldOrder(PaymentCaptureStatus.PENDING_AUTHORIZATION), INTENT_ID),
    reads: READS_AWAITING_AUTHORIZATION,
    admin: ["Release hold", ...SHARE],
    staff: SHARE,
  },
  {
    name: "AUTHORIZED",
    build: () => heldOrder(PaymentCaptureStatus.AUTHORIZED),
    reads: {
      description: "Card authorized — needs capture to take the money",
      badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.AUTHORIZED],
      help: "The funds are held but NOT taken. Capture to charge the card, or release the hold to let them go.",
    },
    admin: ["Capture payment", "Release hold"],
    staff: [],
  },
  {
    name: "CAPTURE_PENDING",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURE_PENDING),
    reads: {
      description: "Capture in progress at the gateway",
      badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_PENDING],
      help: "A capture has been sent to the gateway. This page updates itself when it settles.",
    },
    admin: [],
    staff: [],
  },
  {
    name: "CAPTURE_FAILED",
    build: () => heldOrder(PaymentCaptureStatus.CAPTURE_FAILED),
    reads: {
      description: "Capture failed — the hold is still in place",
      badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_FAILED],
      help: "The gateway rejected the capture. The hold is still live — retry, or release it.",
    },
    admin: ["Retry capture", "Release hold"],
    staff: [],
  },
];

/** A spent hold, which that write leaves alone: before the order is paid
 *  only a new link can collect on it. */
const SPENT_RECORDS: RecordRow[] = [
  {
    name: "CANCELLED",
    build: () => heldOrder(PaymentCaptureStatus.CANCELLED),
    reads: {
      description: "Hold released — the customer was never charged",
      badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.CANCELLED],
      help: "The hold was released without a charge. Nothing was taken from the customer.",
    },
    admin: [GENERATE],
    staff: [GENERATE],
  },
  {
    name: "AUTHORIZATION_EXPIRED",
    build: () => heldOrder(PaymentCaptureStatus.AUTHORIZATION_EXPIRED),
    reads: {
      description: "Authorization expired — the hold has lapsed uncaptured",
      badge: PaymentCaptureStatusLabel[PaymentCaptureStatus.AUTHORIZATION_EXPIRED],
      help: "The hold lapsed before it was captured. Charging this order now needs a fresh payment link.",
    },
    admin: [GENERATE],
    staff: [GENERATE],
  },
];

describe("G8 — the order page's payment card on a PAID order whose authorization record has not caught up, for every role", () => {
  it("SUPER_ADMIN and ADMIN hold ORDER_REGENERATE_LINK, ORDER_CAPTURE_PAYMENT and ORDER_VOID_AUTHORIZATION, and every role ORDER_REGENERATE_LINK: nothing withheld below from SUPER_ADMIN or ADMIN, and no link withheld from STAFF, is for want of a permission", () => {
    expect(CAPTURERS).toEqual([UserRole.SUPER_ADMIN, UserRole.ADMIN]);
    // STAFF too: a new link withheld from STAFF on a PAID order is not for
    // want of ORDER_REGENERATE_LINK.
    expect(REGENERATORS).toEqual(ROLES);
  });

  it("the tables cover every authorization state but CAPTURED, the one the record catches up to", () => {
    const states = [...LAGGING_RECORDS, ...SPENT_RECORDS].map(
      (row) => row.build().payment.capture?.status ?? null,
    );
    expect([...new Set(states)].sort()).toEqual(
      PAYMENT_CAPTURE_STATUSES.filter((s) => s !== PaymentCaptureStatus.CAPTURED).sort(),
    );
    // Both ways for the one state whose controls hang on a recorded intent.
    expect(
      LAGGING_RECORDS.filter(
        (row) => row.build().payment.capture?.status === PaymentCaptureStatus.PENDING_AUTHORIZATION,
      ).map((row) => row.build().payment.paymentIntentId),
    ).toEqual([null, INTENT_ID]);
  });

  // The reading is the same whoever looks: the Authorization panel is not
  // gated on a permission, so STAFF reads it as SUPER_ADMIN and ADMIN do.
  it.each(forEveryRole(LAGGING_RECORDS))(
    "PAID while the record still says $name, as $role: read as captured; no Capture, Retry capture, Release, Regenerate or Generate, no old link",
    ({ build, reads, role }) => {
      renderPage(paid(build()), role);

      expectOrderPage();
      const card = paymentCard();
      expect(readingOf(card)).toEqual(READS_CAPTURED);
      // Nothing on the card still reads the record's own state.
      for (const line of Object.values(reads)) expect(card.textContent).not.toContain(line);
      expect(controls(card)).toEqual([]);
      expectNoOldLink(card);
    },
  );

  it.each(forEveryRole(SPENT_RECORDS))(
    "PAID beside a $name record, as $role: no 'Generate a new payment link', nor any other control, no old link",
    ({ build, role }) => {
      renderPage(paid(build()), role);

      expectOrderPage();
      const card = paymentCard();
      expect(within(card).queryByRole("button", { name: GENERATE })).toBeNull();
      expect(controls(card)).toEqual([]);
      expectNoOldLink(card);
    },
  );

  it.each(forEveryRole([...LAGGING_RECORDS, ...SPENT_RECORDS]))(
    "the same $name record before the order is paid (PAYMENT_PENDING), as $role: read as itself, with the controls that role is offered",
    ({ build, reads, admin, staff, role }) => {
      const order = build();
      expect(order.status).toBe(OrderStatus.PAYMENT_PENDING);
      renderPage(order, role);

      expectOrderPage();
      const card = paymentCard();
      expect(readingOf(card)).toEqual(reads);
      expect(controls(card)).toEqual(role === UserRole.STAFF ? staff : admin);
    },
  );
});
