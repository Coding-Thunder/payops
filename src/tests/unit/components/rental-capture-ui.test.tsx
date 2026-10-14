import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type * as React from "react";

import { CapturePaymentDialog } from "@/components/features/orders/capture-payment-dialog";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { ReleaseAuthorizationDialog } from "@/components/features/orders/release-authorization-dialog";
import { ApiClientError } from "@/lib/api-client";
import {
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentStatus,
  Currency,
  FlightTripType,
  OrderStatus,
  PAYMENT_CAPTURE_STATUSES,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import type {
  OrderCharge,
  OrderDTO,
  OrderFlight,
  OrderHotel,
  OrderPaymentCapture,
} from "@/types";

/**
 * RENTAL ON THE OPERATOR'S CAPTURE SURFACES — the default organization
 * (Rental Confirmation: car rentals only, Stripe only), whose orders are
 * charged at checkout today and which can opt into manual capture like any
 * other organization (`payments.captureMode: MANUAL`). Its car order here:
 * Budget, Toyota Camry, "Rental cost" $249.99 prepaid + "Deposit" $100.00
 * at the counter, for Ada Lovelace.
 *
 *   U1–U3  The order page's money card (`OrderPaymentCard`) in EVERY
 *          authorization state, as SUPER_ADMIN / ADMIN (who may capture and
 *          release) and as STAFF (who may not) — the role half derived
 *          exactly as the order page derives it, from the permission
 *          matrix. Three lifecycles stay apart on it: the payment badge,
 *          the authorization badge and the booking status.
 *   U4     An AUTOMATIC-capture car order — what Rental shows today: no
 *          Authorization panel and no control, and markup byte-identical
 *          whether `payment.capture` is null, undefined or absent, and
 *          whoever is looking.
 *   U5     The capture dialog: everything it restates before it charges,
 *          the vehicle row printed ONCE (the item row and the service's
 *          detail rows both used to open with it), a hotel's property row
 *          likewise, an itinerary flight's rows untouched; the
 *          acknowledgement gate, the toast, and refusals toasted word for
 *          word with the dialog left open.
 *   U6     The release dialog: not a refund, the reason capped at 200
 *          characters and handed to the mutation as `{ reason }`.
 *   U7     The real network path. The card on a page fed by the order
 *          query, the REAL capture hooks — this file's hoisted mock of
 *          `@/hooks/use-capture-payment` is lifted and the card's tree
 *          re-imported — and `fetch` emulating the order API: the request
 *          each control sends, and the card settling on the order the API
 *          answers with, from the query cache, without a reload (the full
 *          request log is pinned: the page's mount GET, then the POST).
 *
 * U1–U6 mock the capture hooks, as the flight operator test does — what is
 * under test there is the components' own logic — and no request may leave
 * the page: every test ends by checking that the unit setup's fetch fence
 * was never called. Every date on these surfaces is formatted in the
 * browser's zone, pinned to UTC here, and every relative one ("Captured 2
 * hours ago") is measured from a pinned clock, so each string below is
 * exact.
 */

/* ------------------------------------------------------------------ *
 * Mocks — no router, no toasts, no mutations (U1–U6)
 * ------------------------------------------------------------------ */

const ROUTER = vi.hoisted(() => ({
  replace: () => {},
  refresh: () => {},
  push: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ROUTER,
  usePathname: () => "/app/orders",
  useSearchParams: () => new URLSearchParams(),
}));

interface CaptureVars {
  amount?: number | null;
}

interface ReleaseVars {
  reason?: string | null;
}

/** What the dialogs hand the mutation hooks — `run` resolves by default. */
const mutations = vi.hoisted(() => ({
  capture: vi.fn<(vars?: CaptureVars) => Promise<unknown>>(async () => undefined),
  release: vi.fn<(vars?: ReleaseVars) => Promise<unknown>>(async () => undefined),
}));

vi.mock("@/hooks/use-capture-payment", () => ({
  useCapturePayment: () => ({
    run: mutations.capture,
    isPending: false,
    error: null,
  }),
  useReleaseAuthorization: () => ({
    run: mutations.release,
    isPending: false,
    error: null,
  }),
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

/** The unit setup's fetch fence, put back after every U7 test. */
const FENCE = globalThis.fetch;

/** "Now" for every relative time on these surfaces: two hours after the
 *  capture below, so a header built from any other timestamp reads
 *  differently ("Captured yesterday" from the authorization). */
const NOW = "2026-10-02T14:00:00.000Z";

let previousTimeZone: string | undefined;

beforeAll(() => {
  // Radix measures and captures the pointer; jsdom implements none of it.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
  previousTimeZone = process.env.TZ;
  process.env.TZ = "UTC";
  // The fence is the setup's mock, so "never called" below means something.
  expect(vi.isMockFunction(FENCE)).toBe(true);
});

beforeEach(() => {
  // Only the clock `formatRelative` reads; every timer stays real. Re-armed
  // per test because the config restores every spy before each one.
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
});

afterEach(() => {
  // Unmount first: a failing hook skips the hooks after it, and the setup's
  // own cleanup must not be one of them, or the next test inherits this DOM.
  cleanup();
  // Nothing reaches the network here except through U7's emulated API.
  expect(FENCE).not.toHaveBeenCalled();
});

afterAll(() => {
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
});

/* ------------------------------------------------------------------ *
 * The order — a Rental car rental, as the order API serves it
 * ------------------------------------------------------------------ */

const ORDER_ID = "665f1c2b9d3e4a0012345678";
const ORDER_NUMBER = "RC-24117";
const CUSTOMER = "Ada Lovelace";
const RENTAL_COST = 249.99;
const SESSION_ID = "cs_test_a1RentalCamry";
const PAYMENT_URL = `https://checkout.stripe.test/c/pay/${SESSION_ID}`;
const INTENT_ID = "pi_test_3RentalCamry";

const AUTHORIZED_AT = "2026-10-01T10:00:00.000Z";
/** The webhook stamps the hold's deadline 7 days after the authorization. */
const CAPTURE_DEADLINE = "2026-10-08T10:00:00.000Z";
const CAPTURED_AT = "2026-10-02T12:00:00.000Z";
const RELEASED_AT = "2026-10-02T12:30:00.000Z";
const RELEASE_REASON = "Supplier could not confirm";
/** Stripe's message for a capture that never reached it — the hold stands. */
const GATEWAY_ERROR =
  "An error occurred with our connection to Stripe. Request was retried 2 times.";

const CAR_CHARGES: OrderCharge[] = [
  { name: "Rental cost", amount: RENTAL_COST, timing: PaymentTiming.PREPAID },
  { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
];

/** The car's breakdown on the money card, row by row — the same in every
 *  state, automatic or manual. */
const CAR_BREAKDOWN = [
  "Rental cost· prepaid | $249.99",
  "Deposit· at counter | $100.00",
  "Amount paid online | $249.99",
  "Amount due at counter | $100.00",
  "Total rental cost | $349.99",
];

/** An automatic-capture car order whose link went out: `payment.capture`
 *  is null and there is no booking status, as on every Rental order today. */
function carOrder(): OrderDTO {
  return {
    id: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    bookingType: BookingType.NEW_BOOKING,
    serviceType: ServiceType.CAR_RENTAL,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    bookingStatus: null,
    customer: { name: CUSTOMER, email: "ada@payops.test", phone: "+15555550100" },
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
    charges: CAR_CHARGES,
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

/** The same order paid at checkout — automatic capture's happy ending. */
function paidCarOrder(): OrderDTO {
  const order = carOrder();
  return {
    ...order,
    status: OrderStatus.PAID,
    payment: {
      ...order.payment,
      status: OrderStatus.PAID,
      paymentIntentId: INTENT_ID,
      paidAt: "2026-10-02T09:00:00.000Z",
      amountReceived: RENTAL_COST,
      confirmationEmailSentAt: "2026-10-02T09:00:05.000Z",
    },
  };
}

/** The booking status each authorization state carries — what the link
 *  generation, the webhooks and the capture service write beside it. */
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
        ? RELEASE_REASON
        : status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED
          ? "automatic"
          : null,
    lastError: status === PaymentCaptureStatus.CAPTURE_FAILED ? GATEWAY_ERROR : null,
  };
}

/**
 * The car order after Rental opted into manual capture, in `status`. Only
 * a capture settles the payment (PAID); every other state leaves it
 * PAYMENT_PENDING — a held or released card is not a paid or failed one.
 */
function heldCarOrder(status: PaymentCaptureStatus): OrderDTO {
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

/** `order` with `payment.capture` set to `value`, or removed outright. */
function withCapture(order: OrderDTO, value: null | undefined | "absent"): OrderDTO {
  const payment: Partial<OrderDTO["payment"]> = { ...order.payment };
  if (value === "absent") delete payment.capture;
  else payment.capture = value;
  return { ...order, payment: payment as OrderDTO["payment"] };
}

const HOTEL: OrderHotel = {
  hotelId: null,
  destination: "Paris",
  propertyName: "Hotel Lutetia",
  checkInDate: "2026-10-17T00:00:00.000Z",
  checkOutDate: "2026-10-20T00:00:00.000Z",
  rooms: 1,
  guests: { adults: 2, children: 0 },
  roomPreference: null,
  guestNotes: null,
  confirmationCode: null,
};

/** A hotel stay on hold for its $640.00 room charge. */
function heldHotelOrder(): OrderDTO {
  const order = heldCarOrder(PaymentCaptureStatus.AUTHORIZED);
  return {
    ...order,
    orderNumber: "HTL-30412",
    serviceType: ServiceType.HOTEL,
    provider: { id: "LUTETIA", name: "Hotel Lutetia", logo: "/providers/lutetia.png" },
    vehicle: null,
    trip: null,
    hotel: HOTEL,
    pricing: { amount: 640, currency: Currency.USD },
    charges: [
      { name: "Room charge", amount: 640, timing: PaymentTiming.PREPAID },
      { name: "City tax", amount: 25.5, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
    payment: {
      ...order.payment,
      capture: { ...hold(PaymentCaptureStatus.AUTHORIZED), amountAuthorized: 640 },
    },
  };
}

/** Delhi → Varanasi → Mumbai, one way — an itinerary flight. */
const FLIGHT: OrderFlight = {
  tripType: FlightTripType.ONE_WAY,
  outbound: {
    segments: [
      {
        origin: "Delhi",
        destination: "Varanasi",
        departure: { date: "2026-10-10", time: "10:30" },
        arrival: { date: "2026-10-10", time: "12:00" },
        airline: "Air India",
        flightNumber: "AI123",
        details: null,
      },
      {
        origin: "Varanasi",
        destination: "Mumbai",
        departure: { date: "2026-10-10", time: "14:30" },
        arrival: { date: "2026-10-10", time: "16:30" },
        airline: "IndiGo",
        flightNumber: "6E456",
        details: null,
      },
    ],
    connections: [{ layover: null }],
  },
  return: null,
  airlineFare: 400,
  cabinClass: "ECONOMY",
  passengers: { adults: 1, children: 0, infants: 0 },
  passengerNotes: null,
  pnr: "PNR7QX",
  airline: null,
  flightNumber: null,
  origin: null,
  destination: null,
  departureDate: null,
  departureTimePreference: null,
  arrivalDate: null,
  returnDate: null,
  returnTimePreference: null,
};

/** An itinerary flight on hold for its $100.00 "Agency Fee". */
function heldFlightOrder(): OrderDTO {
  const order = heldCarOrder(PaymentCaptureStatus.AUTHORIZED);
  return {
    ...order,
    orderNumber: "FLT-24001",
    serviceType: ServiceType.FLIGHT,
    provider: { id: "AIRINDIA", name: "Air India", logo: "/providers/air-india.png" },
    vehicle: null,
    trip: null,
    flight: FLIGHT,
    pricing: { amount: 100, currency: Currency.USD },
    charges: [{ name: "Agency Fee", amount: 100, timing: PaymentTiming.PREPAID }],
    payment: {
      ...order.payment,
      capture: { ...hold(PaymentCaptureStatus.AUTHORIZED), amountAuthorized: 100 },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rendering and reading
 * ------------------------------------------------------------------ */

/** The role half of the capture controls, derived exactly as the order
 *  page derives it (`order-detail-page-content.tsx`). */
function pageFlags(role: UserRole) {
  return {
    canRegenerate: roleHasPermission(role, Permission.ORDER_REGENERATE_LINK),
    canCapture: roleHasPermission(role, Permission.ORDER_CAPTURE_PAYMENT),
    canRelease: roleHasPermission(role, Permission.ORDER_VOID_AUTHORIZATION),
  };
}

/** The money card as the order page mounts it for `role`. */
function renderCard(order: OrderDTO, role: UserRole = UserRole.ADMIN) {
  return render(<OrderPaymentCard order={order} {...pageFlags(role)} />);
}

/** The card's one-line header under its "Payment" title. */
function cardHeader(): string {
  return document.querySelector('[data-slot="card-description"]')?.textContent ?? "";
}

/** The PAYMENT lifecycle badge beside the card title. */
function paymentBadge(): string {
  return (
    document.querySelector('[data-slot="card-header"] [data-slot="badge"]')?.textContent ?? ""
  );
}

/** The AUTHORIZATION panel — null when the card has none. */
function authorizationPanel(): HTMLElement | null {
  const title = screen.queryByText("Authorization", { selector: "p" });
  return title?.parentElement?.parentElement ?? null;
}

/** The AUTHORIZATION lifecycle badge — the panel's first. */
function badgeOf(panel: HTMLElement): string {
  return panel.querySelector('[data-slot="badge"]')?.textContent ?? "";
}

/** Label → value of every field in `scope`, in order. */
function fields(scope: ParentNode): [string, string][] {
  return Array.from(scope.querySelectorAll("p.uppercase"))
    .filter((label) => label.nextElementSibling?.tagName === "P")
    .map((label) => [label.textContent ?? "", label.nextElementSibling?.textContent ?? ""]);
}

function field(scope: ParentNode, label: string): string | undefined {
  return new Map(fields(scope)).get(label);
}

/** The controls in the panel's action row, in order. */
function panelControls(panel: HTMLElement): string[] {
  return within(panel)
    .queryAllByRole("button", { hidden: true })
    .map((button) => button.textContent ?? "");
}

/** Every capture or release control anywhere on the page, hidden or not. */
function captureControls(): string[] {
  return screen
    .queryAllByRole("button", { hidden: true, name: /capture|release/i })
    .map((button) => button.textContent ?? "");
}

/** The "Charge breakdown" box's text, row by row (label | amount). */
function breakdownRows(): string[] {
  const box = screen.getByText("Charge breakdown").parentElement!;
  return Array.from(box.querySelectorAll("div.flex")).map((row) =>
    Array.from(row.children)
      .map((cell) => cell.textContent)
      .join(" | "),
  );
}

/** Opens a dialog from its trigger and returns it. */
function openDialog(trigger: string, title: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  return screen.getByRole("dialog", { name: title });
}

/** Label → value of every summary row in a dialog, in order. */
function summaryRows(dialog: HTMLElement): [string, string][] {
  return Array.from(dialog.querySelectorAll("dt")).map((dt) => [
    dt.textContent ?? "",
    dt.nextElementSibling?.textContent ?? "",
  ]);
}

/** The capture dialog's "I have checked…" acknowledgement, as read. */
function captureAcknowledgement(dialog: HTMLElement): string {
  const label = within(dialog)
    .getByRole("checkbox", { name: "Confirm this capture" })
    .closest("label");
  return (label?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Ticks the acknowledgement and presses the charge button. */
function confirmCapture(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm this capture" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Capture $249.99" }));
}

const CHARGE_TITLE = "Charge $249.99 to this customer?";
const RELEASE_TITLE = "Release the authorization?";
const RELEASE_DESCRIPTION =
  "The $249.99 hold on Ada Lovelace's card is released and the customer is NOT charged. No money has moved, so this is not a refund. Releasing cannot be reversed — a new payment link would be needed to charge this order.";
const RELEASED_TOAST = "Authorization released — the customer was not charged";

/** The hold's own figures while nothing has been taken from it. */
const HELD_FIELDS: [string, string][] = [
  ["Authorized at", "Oct 01, 2026, 10:00 AM"],
  ["Amount authorized", "$249.99"],
  ["Capture deadline", "Oct 08, 2026, 10:00 AM"],
  ["Captured at", "—"],
  ["Amount captured", "—"],
];

/** The panel's fields on an AUTHORIZED car order. */
const AUTHORIZED_FIELDS: [string, string][] = [
  ...HELD_FIELDS,
  ["Booking (not payment)", "Awaiting confirmation"],
];

/* ------------------------------------------------------------------ *
 * U1 — AUTHORIZED: the hold is live
 * ------------------------------------------------------------------ */

describe("U1 — an AUTHORIZED rental car: the hold is live", () => {
  it("the role half comes from the permission matrix: SUPER_ADMIN and ADMIN may capture and release, STAFF may not", () => {
    expect(pageFlags(UserRole.SUPER_ADMIN)).toEqual({
      canRegenerate: true,
      canCapture: true,
      canRelease: true,
    });
    expect(pageFlags(UserRole.ADMIN)).toEqual({
      canRegenerate: true,
      canCapture: true,
      canRelease: true,
    });
    expect(pageFlags(UserRole.STAFF)).toEqual({
      canRegenerate: true,
      canCapture: false,
      canRelease: false,
    });
  });

  it("ADMIN is offered 'Capture payment' and 'Release hold', beside three separate lifecycles", () => {
    renderCard(heldCarOrder(PaymentCaptureStatus.AUTHORIZED), UserRole.ADMIN);

    const panel = authorizationPanel();
    expect(panel).not.toBeNull();
    expect(panelControls(panel!)).toEqual(["Capture payment", "Release hold"]);
    expect(captureControls()).toEqual(["Capture payment", "Release hold"]);

    expect(cardHeader()).toBe("Card authorized — needs capture to take the money");
    // The PAYMENT is still pending, the AUTHORIZATION holds the money, and
    // the BOOKING awaits the supplier — three badges, never one for another.
    expect(paymentBadge()).toBe("Payment pending");
    expect(badgeOf(panel!)).toBe("Authorized — not yet charged");
    expect(fields(panel!)).toEqual(AUTHORIZED_FIELDS);
    expect(
      within(panel!).getByText(
        "The funds are held but NOT taken. Capture to charge the card, or release the hold to let them go.",
      ),
    ).toBeInTheDocument();
    expect(breakdownRows()).toEqual(CAR_BREAKDOWN);
  });

  it("STAFF sees the same panel, header and badge — exactly ADMIN's panel without its controls", () => {
    const order = heldCarOrder(PaymentCaptureStatus.AUTHORIZED);
    const admin = renderCard(order, UserRole.ADMIN);
    const adminPanel = authorizationPanel()!.cloneNode(true) as HTMLElement;
    const actionRow = adminPanel.lastElementChild!;
    expect(
      Array.from(actionRow.querySelectorAll("button")).map((b) => b.textContent),
    ).toEqual(["Capture payment", "Release hold"]);
    actionRow.remove();
    admin.unmount();

    renderCard(order, UserRole.STAFF);
    const panel = authorizationPanel();
    expect(panel).not.toBeNull();
    expect(cardHeader()).toBe("Card authorized — needs capture to take the money");
    expect(badgeOf(panel!)).toBe("Authorized — not yet charged");
    expect(fields(panel!)).toEqual(AUTHORIZED_FIELDS);
    expect(panelControls(panel!)).toEqual([]);
    expect(captureControls()).toEqual([]);
    expect(panel!.innerHTML).toBe(adminPanel.innerHTML);
  });
});

/* ------------------------------------------------------------------ *
 * U2 — CAPTURE_FAILED: the hold is still in place
 * ------------------------------------------------------------------ */

describe("U2 — a CAPTURE_FAILED rental car: the hold is still in place", () => {
  it("ADMIN is offered 'Retry capture' and 'Release hold', with the gateway's last error on the card", () => {
    renderCard(heldCarOrder(PaymentCaptureStatus.CAPTURE_FAILED), UserRole.ADMIN);

    const panel = authorizationPanel()!;
    expect(cardHeader()).toBe("Capture failed — the hold is still in place");
    expect(badgeOf(panel)).toBe("Capture failed");
    expect(panelControls(panel)).toEqual(["Retry capture", "Release hold"]);
    expect(field(panel, "Last capture error")).toBe(GATEWAY_ERROR);
    expect(field(panel, "Amount authorized")).toBe("$249.99");
    expect(field(panel, "Booking (not payment)")).toBe("Awaiting confirmation");
    expect(paymentBadge()).toBe("Payment pending");
  });

  it("'Retry capture' opens the same charge dialog, which repeats the last error", () => {
    renderCard(heldCarOrder(PaymentCaptureStatus.CAPTURE_FAILED), UserRole.ADMIN);

    const dialog = openDialog("Retry capture", CHARGE_TITLE);
    expect(
      within(dialog).getByText(`Last capture attempt failed: ${GATEWAY_ERROR}`),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Capture $249.99" })).toBeDisabled();
  });

  it("STAFF still reads the error, but is offered no control", () => {
    renderCard(heldCarOrder(PaymentCaptureStatus.CAPTURE_FAILED), UserRole.STAFF);

    const panel = authorizationPanel()!;
    expect(field(panel, "Last capture error")).toBe(GATEWAY_ERROR);
    expect(panelControls(panel)).toEqual([]);
    expect(captureControls()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * U3 — every authorization state, table-driven
 * ------------------------------------------------------------------ */

interface LifecycleRow {
  status: PaymentCaptureStatus;
  /** The card's header line. */
  header: string;
  /** The AUTHORIZATION badge. */
  badge: string;
  /** The sentence under it. */
  help: string;
  /** The PAYMENT badge. */
  payment: string;
  /** The "Booking (not payment)" field. */
  booking: string;
  /** Every field of the panel, label → value, in order. */
  fields: [string, string][];
  /** What SUPER_ADMIN and ADMIN are offered, in order. STAFF: nothing. */
  controls: string[];
}

const LIFECYCLE: LifecycleRow[] = [
  {
    status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    header: "Waiting for the customer to authorize their card",
    badge: "Awaiting authorization",
    help: "No hold exists yet. Nothing can be captured until the customer completes checkout.",
    payment: "Payment pending",
    booking: "Awaiting confirmation",
    fields: [
      ["Authorized at", "—"],
      ["Amount authorized", "—"],
      ["Capture deadline", "—"],
      ["Captured at", "—"],
      ["Amount captured", "—"],
      ["Booking (not payment)", "Awaiting confirmation"],
    ],
    controls: ["Release hold"],
  },
  {
    status: PaymentCaptureStatus.AUTHORIZED,
    header: "Card authorized — needs capture to take the money",
    badge: "Authorized — not yet charged",
    help: "The funds are held but NOT taken. Capture to charge the card, or release the hold to let them go.",
    payment: "Payment pending",
    booking: "Awaiting confirmation",
    fields: AUTHORIZED_FIELDS,
    controls: ["Capture payment", "Release hold"],
  },
  {
    status: PaymentCaptureStatus.CAPTURE_PENDING,
    header: "Capture in progress at the gateway",
    badge: "Capture in progress",
    help: "A capture has been sent to the gateway. This page updates itself when it settles.",
    payment: "Payment pending",
    booking: "Awaiting confirmation",
    fields: AUTHORIZED_FIELDS,
    controls: [],
  },
  {
    status: PaymentCaptureStatus.CAPTURED,
    // Relative to `capturedAt` (12:00), two hours before NOW.
    header: "Captured 2 hours ago",
    badge: "Captured",
    help: "The money has been taken. Reversing it now means issuing a refund.",
    payment: "Paid",
    booking: "Confirmed",
    fields: [
      ["Authorized at", "Oct 01, 2026, 10:00 AM"],
      ["Amount authorized", "$249.99"],
      ["Capture deadline", "Oct 08, 2026, 10:00 AM"],
      ["Captured at", "Oct 02, 2026, 12:00 PM"],
      ["Amount captured", "$249.99"],
      ["Booking (not payment)", "Confirmed"],
    ],
    controls: [],
  },
  {
    status: PaymentCaptureStatus.CAPTURE_FAILED,
    header: "Capture failed — the hold is still in place",
    badge: "Capture failed",
    help: "The gateway rejected the capture. The hold is still live — retry, or release it.",
    payment: "Payment pending",
    booking: "Awaiting confirmation",
    fields: [...AUTHORIZED_FIELDS, ["Last capture error", GATEWAY_ERROR]],
    controls: ["Retry capture", "Release hold"],
  },
  {
    status: PaymentCaptureStatus.CANCELLED,
    header: "Hold released — the customer was never charged",
    badge: "Authorization released",
    help: "The hold was released without a charge. Nothing was taken from the customer.",
    payment: "Payment pending",
    booking: "Cancelled",
    fields: [
      ...HELD_FIELDS,
      ["Hold released", "Oct 02, 2026, 12:30 PM"],
      ["Release reason", RELEASE_REASON],
      ["Booking (not payment)", "Cancelled"],
    ],
    controls: [],
  },
  {
    status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
    header: "Authorization expired — the hold has lapsed uncaptured",
    badge: "Authorization expired",
    help: "The hold lapsed before it was captured. Charging this order now needs a fresh payment link.",
    payment: "Payment pending",
    booking: "Cancelled",
    fields: [
      ...HELD_FIELDS,
      ["Hold released", "Oct 02, 2026, 12:30 PM"],
      // Stripe's own cancellation_reason, as the webhook stores it.
      ["Release reason", "automatic"],
      ["Booking (not payment)", "Cancelled"],
    ],
    controls: [],
  },
];

const ROLES = [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF];

describe("U3 — every authorization state of a rental car, for every role", () => {
  it("the table covers every PaymentCaptureStatus", () => {
    expect(LIFECYCLE.map((row) => row.status).sort()).toEqual(
      [...PAYMENT_CAPTURE_STATUSES].sort(),
    );
  });

  it.each(LIFECYCLE.flatMap((row) => ROLES.map((role) => ({ ...row, role }))))(
    "$status as $role: header, the three lifecycle badges, help text, every field and the controls offered",
    ({ status, header, badge, help, payment, booking, fields: expected, controls, role }) => {
      renderCard(heldCarOrder(status), role);

      expect(cardHeader()).toBe(header);
      expect(paymentBadge()).toBe(payment);
      const panel = authorizationPanel();
      expect(panel).not.toBeNull();
      expect(badgeOf(panel!)).toBe(badge);
      expect(within(panel!).getByText(help)).toBeInTheDocument();
      expect(field(panel!, "Booking (not payment)")).toBe(booking);
      expect(fields(panel!)).toEqual(expected);

      const offered = role === UserRole.STAFF ? [] : controls;
      expect(panelControls(panel!)).toEqual(offered);
      expect(captureControls()).toEqual(offered);
      expect(breakdownRows()).toEqual(CAR_BREAKDOWN);
    },
  );
});

/* ------------------------------------------------------------------ *
 * U4 — automatic capture: what Rental shows today
 * ------------------------------------------------------------------ */

interface AutomaticCase {
  name: string;
  build: () => OrderDTO;
  header: string;
  payment: string;
  fields: [string, string][];
  /** Every button on the card, hidden or not. */
  buttons: string[];
}

const AUTOMATIC: AutomaticCase[] = [
  {
    name: "awaiting payment on its link",
    build: carOrder,
    header: "Awaiting customer payment",
    payment: "Payment pending",
    fields: [
      ["Charged online", "$249.99"],
      ["Currency", "USD"],
      ["Expires", "Oct 03, 2026, 09:05 AM"],
      ["Gateway", "Stripe"],
      ["Payment session", SESSION_ID],
      ["Payment link to share with the customer", PAYMENT_URL],
    ],
    buttons: ["Copy link", "Regenerate link"],
  },
  {
    name: "paid at checkout",
    build: paidCarOrder,
    // Relative to `paidAt` (09:00), five hours before NOW.
    header: "Settled 5 hours ago",
    payment: "Paid",
    fields: [
      ["Paid online", "$249.99"],
      ["Amount received", "$249.99"],
      ["Expires", "Oct 03, 2026, 09:05 AM"],
      ["Gateway", "Stripe"],
      ["Payment session", SESSION_ID],
    ],
    buttons: [],
  },
];

/** The card's markup for `ui`, rendered on its own. */
function markup(ui: React.ReactElement): string {
  const { container, unmount } = render(ui);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("U4 — an AUTOMATIC-capture rental car (capture null): what Rental shows today", () => {
  it.each(AUTOMATIC)(
    "$name: no Authorization panel and no capture or release control, for any role",
    ({ build, header, payment, fields: expected, buttons }) => {
      for (const role of ROLES) {
        const { container, unmount } = renderCard(build(), role);

        expect(authorizationPanel()).toBeNull();
        expect(container.textContent).not.toMatch(/authoriz|captur|releas|hold/i);
        expect(captureControls()).toEqual([]);
        expect(cardHeader()).toBe(header);
        expect(paymentBadge()).toBe(payment);
        expect(fields(container)).toEqual(expected);
        expect(breakdownRows()).toEqual(CAR_BREAKDOWN);
        expect(
          screen
            .queryAllByRole("button", { hidden: true })
            .map((button) => button.textContent),
        ).toEqual(buttons);
        unmount();
      }
    },
  );

  it.each(AUTOMATIC)(
    "$name: byte-identical whether capture is null, undefined or absent — and whoever is looking",
    ({ build, header, payment, fields: expected }) => {
      const order = build();

      // The reference — pinned on its own first, so the comparisons below
      // cannot all agree on something wrong.
      const reference = renderCard(order, UserRole.ADMIN);
      expect(authorizationPanel()).toBeNull();
      expect(captureControls()).toEqual([]);
      expect(cardHeader()).toBe(header);
      expect(paymentBadge()).toBe(payment);
      expect(fields(reference.container)).toEqual(expected);
      expect(breakdownRows()).toEqual(CAR_BREAKDOWN);
      const html = reference.container.innerHTML;
      reference.unmount();

      const admin = pageFlags(UserRole.ADMIN);
      expect(markup(<OrderPaymentCard order={withCapture(order, null)} {...admin} />)).toBe(html);
      expect(markup(<OrderPaymentCard order={withCapture(order, undefined)} {...admin} />)).toBe(
        html,
      );
      expect(markup(<OrderPaymentCard order={withCapture(order, "absent")} {...admin} />)).toBe(
        html,
      );
      expect(
        markup(<OrderPaymentCard order={order} {...pageFlags(UserRole.SUPER_ADMIN)} />),
      ).toBe(html);
      expect(markup(<OrderPaymentCard order={order} {...pageFlags(UserRole.STAFF)} />)).toBe(
        html,
      );
      // A caller from before capture existed passes no capture props at all.
      expect(markup(<OrderPaymentCard order={order} canRegenerate />)).toBe(html);
    },
  );
});

/* ------------------------------------------------------------------ *
 * U5 — the capture dialog
 * ------------------------------------------------------------------ */

describe("U5 — CapturePaymentDialog for the rental car", () => {
  it("reads before it charges: the title, the order — Vehicle ONCE, then Pick-up and Drop-off — and the hold", () => {
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Capture payment", CHARGE_TITLE);
    expect(dialog).toHaveAccessibleDescription(
      "This captures the authorization and moves real money now. Captures cannot be undone — correcting one means issuing a refund.",
    );
    expect(summaryRows(dialog)).toEqual([
      ["Order", ORDER_NUMBER],
      ["Booking status", "Awaiting confirmation"],
      ["Customer", CUSTOMER],
      ["Email", "ada@payops.test"],
      ["Vehicle", "Toyota Camry"],
      ["Pick-up", "Oct 17, 2026"],
      ["Drop-off", "Oct 20, 2026"],
      ["Amount to charge", "$249.99"],
      ["Currency", "USD"],
      ["Authorization expires", "Oct 08, 2026, 10:00 AM"],
    ]);
    // The duplicate-row fix: the label is printed once in the whole dialog.
    expect(within(dialog).getAllByText("Vehicle", { exact: true })).toHaveLength(1);
    expect(
      within(dialog).getByText(
        "The booking is still awaiting confirmation. Capture once the supplier has confirmed it — the hold stays valid until the expiry above.",
      ),
    ).toBeInTheDocument();
    expect(captureAcknowledgement(dialog)).toBe(
      `I have checked the details above and want to charge $249.99 to ${CUSTOMER} now.`,
    );
  });

  it("the 'Capture $249.99' button stays disabled until 'Confirm this capture' is ticked", () => {
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Capture payment", CHARGE_TITLE);
    const checkbox = within(dialog).getByRole("checkbox", { name: "Confirm this capture" });
    const confirm = within(dialog).getByRole("button", { name: "Capture $249.99" });
    expect(checkbox).not.toBeChecked();
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mutations.capture).not.toHaveBeenCalled();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(confirm).toBeEnabled();
  });

  it("confirming runs the capture once — the whole hold, no amount — toasts 'Captured $249.99' and closes", async () => {
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    confirmCapture(openDialog("Capture payment", CHARGE_TITLE));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Captured $249.99"));
    expect(mutations.capture).toHaveBeenCalledTimes(1);
    expect(mutations.capture).toHaveBeenCalledWith();
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Opened again, the acknowledgement starts over.
    const again = openDialog("Capture payment", CHARGE_TITLE);
    expect(within(again).getByRole("checkbox", { name: "Confirm this capture" })).not.toBeChecked();
  });

  it("a refusal from the API is toasted word for word, and the dialog stays open to retry", async () => {
    mutations.capture.mockRejectedValueOnce(
      new ApiClientError(409, {
        code: "CONFLICT",
        message: "Cannot capture — the payment is cancelled.",
      }),
    );
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    confirmCapture(openDialog("Capture payment", CHARGE_TITLE));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Cannot capture — the payment is cancelled."),
    );
    expect(mutations.capture).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: CHARGE_TITLE });
    expect(within(dialog).getByRole("checkbox", { name: "Confirm this capture" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Capture $249.99" })).toBeEnabled();
  });

  it("any other failure falls back to 'Could not capture the payment'", async () => {
    mutations.capture.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    confirmCapture(openDialog("Capture payment", CHARGE_TITLE));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not capture the payment"),
    );
    expect(screen.getByRole("dialog", { name: CHARGE_TITLE })).toBeInTheDocument();
  });

  it("'Cancel' closes it without charging", () => {
    render(<CapturePaymentDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Capture payment", CHARGE_TITLE);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm this capture" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutations.capture).not.toHaveBeenCalled();
  });

  it("a HOTEL's dialog prints its Property row once", () => {
    render(<CapturePaymentDialog order={heldHotelOrder()} />);

    const dialog = openDialog("Capture payment", "Charge $640.00 to this customer?");
    expect(summaryRows(dialog)).toEqual([
      ["Order", "HTL-30412"],
      ["Booking status", "Awaiting confirmation"],
      ["Customer", CUSTOMER],
      ["Email", "ada@payops.test"],
      ["Property", "Hotel Lutetia • Paris"],
      ["Destination", "Paris"],
      ["Check-in", "17 Oct 2026"],
      ["Check-out", "20 Oct 2026"],
      ["Rooms", "1 room"],
      ["Guests", "2 adults"],
      ["Amount to charge", "$640.00"],
      ["Currency", "USD"],
      ["Authorization expires", "Oct 08, 2026, 10:00 AM"],
    ]);
    expect(within(dialog).getAllByText("Property", { exact: true })).toHaveLength(1);
  });

  it("an itinerary FLIGHT keeps every trip row, its Route included — it has no item row to duplicate", () => {
    render(<CapturePaymentDialog order={heldFlightOrder()} />);

    const dialog = openDialog("Capture payment", "Charge the $100.00 Agency Fee to this customer?");
    expect(summaryRows(dialog)).toEqual([
      ["Order", "FLT-24001"],
      ["Booking status", "Awaiting confirmation"],
      ["Customer", CUSTOMER],
      ["Email", "ada@payops.test"],
      ["Trip type", "One way"],
      ["Route", "Delhi → Varanasi → Mumbai"],
      ["Cabin", "Economy"],
      ["Passengers", "1 adult"],
      ["PNR", "PNR7QX"],
      ["Agency Fee to capture", "$100.00"],
      ["Currency", "USD"],
      ["Authorization expires", "Oct 08, 2026, 10:00 AM"],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * U6 — the release dialog
 * ------------------------------------------------------------------ */

describe("U6 — ReleaseAuthorizationDialog for the rental car", () => {
  it("names the $249.99 hold, says it is not a refund, and offers 'Release hold' / 'Keep hold' and a reason of up to 200", () => {
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    expect(dialog).toHaveAccessibleDescription(RELEASE_DESCRIPTION);
    expect(within(dialog).getByRole("button", { name: "Release hold" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Keep hold" })).toBeEnabled();
    const reason = within(dialog).getByLabelText("Reason (optional)");
    expect(reason.tagName).toBe("TEXTAREA");
    expect(reason).toHaveAttribute("maxLength", "200");
    expect(reason).toHaveAttribute(
      "placeholder",
      "Supplier could not confirm, duplicate booking, customer withdrew…",
    );
    expect(reason).toHaveValue("");
    expect(within(dialog).getByText("0/200")).toBeInTheDocument();
  });

  it("'Release hold' hands the trimmed reason to run as { reason }, toasts and closes", async () => {
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: `  ${RELEASE_REASON}  ` },
    });
    expect(within(dialog).getByText("30/200")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(RELEASED_TOAST));
    expect(mutations.release).toHaveBeenCalledTimes(1);
    expect(mutations.release).toHaveBeenCalledWith({ reason: RELEASE_REASON });
    expect(toasts.error).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an empty reason is handed over as null", async () => {
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(mutations.release).toHaveBeenCalledWith({ reason: null }));
    expect(mutations.release).toHaveBeenCalledTimes(1);
  });

  it("the reason is capped at 200 characters", async () => {
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    const reason = within(dialog).getByLabelText("Reason (optional)");
    fireEvent.change(reason, { target: { value: "R".repeat(250) } });
    expect(reason).toHaveValue("R".repeat(200));
    expect(within(dialog).getByText("200/200")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() =>
      expect(mutations.release).toHaveBeenCalledWith({ reason: "R".repeat(200) }),
    );
  });

  it("a refusal from the API is toasted word for word; the dialog and the typed reason stay", async () => {
    const refusal =
      "This payment has already been captured. Issue a refund instead of releasing the authorization.";
    mutations.release.mockRejectedValueOnce(
      new ApiClientError(409, { code: "CONFLICT", message: refusal }),
    );
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: RELEASE_REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(refusal));
    expect(toasts.success).not.toHaveBeenCalled();
    const stillOpen = screen.getByRole("dialog", { name: RELEASE_TITLE });
    expect(within(stillOpen).getByLabelText("Reason (optional)")).toHaveValue(RELEASE_REASON);
  });

  it("any other failure falls back to 'Could not release the authorization'", async () => {
    mutations.release.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not release the authorization"),
    );
    expect(screen.getByRole("dialog", { name: RELEASE_TITLE })).toBeInTheDocument();
  });

  it("'Keep hold' closes it without releasing, and forgets the reason", () => {
    render(<ReleaseAuthorizationDialog order={heldCarOrder(PaymentCaptureStatus.AUTHORIZED)} />);

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: RELEASE_REASON },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep hold" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutations.release).not.toHaveBeenCalled();

    const again = openDialog("Release hold", RELEASE_TITLE);
    expect(within(again).getByLabelText("Reason (optional)")).toHaveValue("");
  });
});

/* ------------------------------------------------------------------ *
 * U7 — the real network path
 * ------------------------------------------------------------------ */

interface ApiCall {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  contentType: string | undefined;
}

/** What the server holds. Each route answers from (and writes) it. */
let stored: OrderDTO;
let calls: ApiCall[] = [];
/** One-shot: the next capture is rejected by the gateway. */
let gatewayRejectsNextCapture = false;

/** POST /capture as `capturePayment` writes it: the PAYMENT settles (PAID,
 *  through the shared paid transition) and the BOOKING is confirmed. */
function capturedOnServer(order: OrderDTO): OrderDTO {
  const capture = order.payment.capture!;
  const amount = capture.amountAuthorized ?? order.pricing.amount;
  return {
    ...order,
    status: OrderStatus.PAID,
    bookingStatus: BookingStatus.CONFIRMED,
    payment: {
      ...order.payment,
      status: OrderStatus.PAID,
      paidAt: CAPTURED_AT,
      amountReceived: amount,
      capture: {
        ...capture,
        status: PaymentCaptureStatus.CAPTURED,
        capturedAt: CAPTURED_AT,
        amountCaptured: amount,
        lastError: null,
      },
    },
  };
}

/** A gateway rejection as `capturePayment` handles it: the claim rolls back
 *  to CAPTURE_FAILED with the gateway's message (the route answers 502). */
function captureFailedOnServer(order: OrderDTO): OrderDTO {
  return {
    ...order,
    payment: {
      ...order.payment,
      capture: {
        ...order.payment.capture!,
        status: PaymentCaptureStatus.CAPTURE_FAILED,
        lastError: GATEWAY_ERROR,
      },
    },
  };
}

/** POST /cancel-authorization as `cancelAuthorization` writes it: the hold
 *  is released and the booking cancelled; the payment status is untouched. */
function releasedOnServer(order: OrderDTO, reason: string | null): OrderDTO {
  return {
    ...order,
    bookingStatus: BookingStatus.CANCELLED,
    payment: {
      ...order.payment,
      capture: {
        ...order.payment.capture!,
        status: PaymentCaptureStatus.CANCELLED,
        cancelledAt: RELEASED_AT,
        cancelReason: reason,
      },
    },
  };
}

function respond(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The order API, emulated with the envelopes `jsonOk` / `jsonError` send. */
function serve(initial: OrderDTO) {
  stored = initial;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ method, url, body, contentType: headers["Content-Type"] });
      if (method === "GET" && url === `/api/orders/${ORDER_ID}`) {
        return respond(200, { ok: true, data: stored });
      }
      if (method === "POST" && url === `/api/orders/${ORDER_ID}/capture`) {
        if (gatewayRejectsNextCapture) {
          gatewayRejectsNextCapture = false;
          stored = captureFailedOnServer(stored);
          return respond(502, {
            ok: false,
            error: { code: "PAYMENT_ERROR", message: "Could not capture this payment" },
          });
        }
        stored = capturedOnServer(stored);
        return respond(200, { ok: true, data: { order: stored } });
      }
      if (method === "POST" && url === `/api/orders/${ORDER_ID}/cancel-authorization`) {
        const reason = typeof body?.reason === "string" ? body.reason : null;
        stored = releasedOnServer(stored, reason);
        return respond(200, { ok: true, data: { order: stored } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
}

function posts(): ApiCall[] {
  return calls.filter((call) => call.method === "POST");
}

const ORDER_URL = `/api/orders/${ORDER_ID}`;

/** The whole request log, "METHOD url", in order. */
function requests(): string[] {
  return calls.map((call) => `${call.method} ${call.url}`);
}

describe("U7 — through the network: the REAL capture hooks post to the order API and the card follows the cache", () => {
  let rq: typeof import("@tanstack/react-query");
  let liveOrderKey: typeof import("@/hooks/use-order-query").orderQueryKey;
  let LiveOrderPage: (props: { role: UserRole }) => React.ReactElement | null;
  let client: QueryClient;

  beforeAll(async () => {
    // Lift this file's hoisted mock of the capture hooks and load the
    // card's whole tree afresh, so it binds the REAL module: real
    // `useMutation`, real `api.post`, real cache writes.
    vi.doUnmock("@/hooks/use-capture-payment");
    vi.resetModules();
    rq = await import("@tanstack/react-query");
    const query = await import("@/hooks/use-order-query");
    const { OrderPaymentCard: LiveCard } = await import(
      "@/components/features/orders/order-payment-card"
    );
    liveOrderKey = query.orderQueryKey;
    const useLiveOrderQuery = query.useOrderQuery;
    // The card the way the order page mounts it: fed by the order query,
    // so whatever the hooks write to the cache is what it is rendered with.
    LiveOrderPage = function LiveOrderPage({ role }: { role: UserRole }) {
      const { data } = useLiveOrderQuery(ORDER_ID);
      return data ? <LiveCard order={data} {...pageFlags(role)} /> : null;
    };
  });

  beforeEach(() => {
    calls = [];
    gatewayRejectsNextCapture = false;
    client = new rq.QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    cleanup();
    client.clear();
    vi.stubGlobal("fetch", FENCE);
  });

  /** Seeds the cache, mounts the page and waits out its first fetch, as
   *  the order page has long before an operator reaches for a button. */
  async function renderLivePage(order: OrderDTO, role: UserRole = UserRole.ADMIN) {
    serve(order);
    client.setQueryData(liveOrderKey(ORDER_ID), order);
    const Provider = rq.QueryClientProvider;
    const Page = LiveOrderPage;
    render(
      <Provider client={client}>
        <Page role={role} />
      </Provider>,
    );
    // The seeded order is stale at once (staleTime 0), so the page refetches
    // it on mount. Wait that GET out explicitly, so every request after it
    // is one a control sent.
    await waitFor(() => {
      expect(requests()).toEqual([`GET ${ORDER_URL}`]);
      expect(client.isFetching()).toBe(0);
    });
  }

  function cached(): OrderDTO {
    return client.getQueryData<OrderDTO>(liveOrderKey(ORDER_ID))!;
  }

  it("Capture: POST /capture { amount: null }; the order it answers with lands in the cache and the card settles on Captured", async () => {
    await renderLivePage(heldCarOrder(PaymentCaptureStatus.AUTHORIZED));

    confirmCapture(openDialog("Capture payment", CHARGE_TITLE));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Captured $249.99"));
    expect(posts()).toEqual([
      {
        method: "POST",
        url: `/api/orders/${ORDER_ID}/capture`,
        body: { amount: null },
        contentType: "application/json",
      },
    ]);
    // The mocked hooks of U1–U6 played no part.
    expect(mutations.capture).not.toHaveBeenCalled();

    // The cache holds what the server answered — exactly that order…
    expect(cached().status).toBe(OrderStatus.PAID);
    expect(cached().bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(cached().payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CAPTURED,
      capturedAt: CAPTURED_AT,
      amountCaptured: RENTAL_COST,
    });
    expect(cached()).toEqual(stored);
    // …and the card renders from it.
    await waitFor(() => expect(cardHeader()).toBe("Captured 2 hours ago"));
    const panel = authorizationPanel()!;
    expect(badgeOf(panel)).toBe("Captured");
    expect(field(panel, "Amount captured")).toBe("$249.99");
    expect(field(panel, "Booking (not payment)")).toBe("Confirmed");
    expect(paymentBadge()).toBe("Paid");
    expect(captureControls()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
    // No reload: the card settled on the POST's own answer, written to the
    // cache — the only GET is the page's mount fetch.
    expect(requests()).toEqual([`GET ${ORDER_URL}`, `POST ${ORDER_URL}/capture`]);
  });

  it("Release: POST /cancel-authorization with the trimmed { reason }; the card settles on 'Hold released'", async () => {
    await renderLivePage(heldCarOrder(PaymentCaptureStatus.AUTHORIZED));

    const dialog = openDialog("Release hold", RELEASE_TITLE);
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: `  ${RELEASE_REASON}  ` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Release hold" }));

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(RELEASED_TOAST));
    expect(posts()).toEqual([
      {
        method: "POST",
        url: `/api/orders/${ORDER_ID}/cancel-authorization`,
        body: { reason: RELEASE_REASON },
        contentType: "application/json",
      },
    ]);
    expect(mutations.release).not.toHaveBeenCalled();

    expect(cached().payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CANCELLED,
      cancelReason: RELEASE_REASON,
    });
    // A released hold is not a failed payment: the payment status stays.
    expect(cached().status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(cached().bookingStatus).toBe(BookingStatus.CANCELLED);
    expect(cached()).toEqual(stored);

    await waitFor(() =>
      expect(cardHeader()).toBe("Hold released — the customer was never charged"),
    );
    const panel = authorizationPanel()!;
    expect(badgeOf(panel)).toBe("Authorization released");
    expect(field(panel, "Release reason")).toBe(RELEASE_REASON);
    expect(field(panel, "Booking (not payment)")).toBe("Cancelled");
    expect(paymentBadge()).toBe("Payment pending");
    expect(captureControls()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests()).toEqual([
      `GET ${ORDER_URL}`,
      `POST ${ORDER_URL}/cancel-authorization`,
    ]);
  });

  it("A gateway rejection: the 502's message is toasted, the dialog stays open, and the next poll shows 'Retry capture' with the gateway's error", async () => {
    await renderLivePage(heldCarOrder(PaymentCaptureStatus.AUTHORIZED));
    gatewayRejectsNextCapture = true;

    confirmCapture(openDialog("Capture payment", CHARGE_TITLE));

    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not capture this payment"),
    );
    expect(toasts.success).not.toHaveBeenCalled();
    expect(posts()).toEqual([
      {
        method: "POST",
        url: `/api/orders/${ORDER_ID}/capture`,
        body: { amount: null },
        contentType: "application/json",
      },
    ]);
    expect(screen.getByRole("dialog", { name: CHARGE_TITLE })).toBeInTheDocument();
    // The client never guesses: only an answer from the server moves the
    // cache, which still holds the order the page loaded.
    expect(cached().payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(cached()).toEqual(heldCarOrder(PaymentCaptureStatus.AUTHORIZED));
    expect(requests()).toEqual([`GET ${ORDER_URL}`, `POST ${ORDER_URL}/capture`]);

    // The next poll brings what the server recorded.
    await act(async () => {
      await client.refetchQueries({ queryKey: liveOrderKey(ORDER_ID) });
    });
    expect(requests()).toEqual([
      `GET ${ORDER_URL}`,
      `POST ${ORDER_URL}/capture`,
      `GET ${ORDER_URL}`,
    ]);
    expect(cached().payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    const dialog = screen.getByRole("dialog", { name: CHARGE_TITLE });
    await waitFor(() =>
      expect(
        within(dialog).getByText(`Last capture attempt failed: ${GATEWAY_ERROR}`),
      ).toBeInTheDocument(),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cardHeader()).toBe("Capture failed — the hold is still in place");
    const panel = authorizationPanel()!;
    expect(field(panel, "Last capture error")).toBe(GATEWAY_ERROR);
    expect(captureControls()).toEqual(["Retry capture", "Release hold"]);
  });

  it("'Retry capture' on a CAPTURE_FAILED order posts the same capture and settles the card on Captured", async () => {
    await renderLivePage(heldCarOrder(PaymentCaptureStatus.CAPTURE_FAILED));

    const dialog = openDialog("Retry capture", CHARGE_TITLE);
    expect(
      within(dialog).getByText(`Last capture attempt failed: ${GATEWAY_ERROR}`),
    ).toBeInTheDocument();
    confirmCapture(dialog);

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Captured $249.99"));
    expect(posts()).toEqual([
      {
        method: "POST",
        url: `/api/orders/${ORDER_ID}/capture`,
        body: { amount: null },
        contentType: "application/json",
      },
    ]);
    await waitFor(() => expect(cardHeader()).toBe("Captured 2 hours ago"));
    expect(cached().payment.capture?.lastError).toBeNull();
    expect(field(authorizationPanel()!, "Last capture error")).toBeUndefined();
    expect(captureControls()).toEqual([]);
    expect(requests()).toEqual([`GET ${ORDER_URL}`, `POST ${ORDER_URL}/capture`]);
  });
});
