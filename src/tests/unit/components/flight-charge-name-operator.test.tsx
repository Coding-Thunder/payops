import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";

import { EvidenceChainView } from "@/components/features/evidence/evidence-chain-view";
import { CapturePaymentDialog } from "@/components/features/orders/capture-payment-dialog";
import { EmailComposePageContent } from "@/components/features/orders/email-compose-page-content";
import { EmailComposer } from "@/components/features/orders/email-composer";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { PaymentStatusFloater } from "@/components/features/orders/payment-status-floater";
import { ReleaseAuthorizationDialog } from "@/components/features/orders/release-authorization-dialog";
import { flightCollection, summarizeFlightAmounts } from "@/lib/charges";
import {
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentStatus,
  Currency,
  FlightTripType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
} from "@/lib/constants/enums";
import { buildFlightItinerary } from "@/lib/flight-itinerary";
import { describeServiceItem, serviceDetailRows } from "@/lib/service-summary";
import type { OrderEvidenceChainWithFlightDTO } from "@/server/services/evidence.service";
import type {
  OrderDTO,
  OrderFlight,
  OrderFlightSegment,
  OrderPaymentCapture,
} from "@/types";

/**
 * THE OPERATOR NAMES THE ONE CHARGE A FLIGHT'S PAYMENT LINK COLLECTS — and
 * every operator surface that labels that amount reads the STORED name
 * (`order.charges[0].name`), never a hardcoded "Service Charge".
 *
 *   Airline Charge        $400.00   `flight.airlineFare`: fixed label, shown
 *                                   for the booking value, NEVER collected.
 *   <the operator's name> $100.00   the one charge line ("Rental Cost",
 *                                   "Agency Fee"…): all the link collects.
 *   Total Booking Value   $500.00
 *   Amount Payable Now    $100.00
 *
 * Pinned here, on the order DTO the order API serves, surface by surface:
 *
 *   - the email composer's payment summary card, and the compose page's
 *     order summary around it;
 *   - the capture dialog (title, the "<name> to capture" row, the
 *     confirmation sentence, the button and the toast), the release dialog
 *     ("$100.00 <name> hold") and the live status floater ("Charging the
 *     authorized <name> now.");
 *   - the order detail page's money card;
 *   - the evidence page's flight money rows, from the evidence DTO's
 *     `chargeName` — "Charged Online" when it is empty.
 *
 * Every named case runs for two names, so a label that happens to equal
 * one constant cannot pass. A MODIFICATION keeps the neutral SENTENCES
 * (`serviceChargeModel` is false: "Charge $100.00 to this customer?") while
 * its LABELS still carry its name ("Modification Fee").
 *
 * The composer's default subject names the charge too — "Complete your
 * <name> payment" — never the airline; a car's keeps its provider.
 */

/* ------------------------------------------------------------------ *
 * Mocks — no router, no SSE feed, no network, no mutations
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

/** No live events: every surface renders from the order alone. */
const FEED = vi.hoisted(() => ({
  events: [] as unknown[],
  push: () => {},
  clear: () => {},
}));

vi.mock("@/hooks/use-activity-feed", () => ({
  useActivityFeed: () => FEED,
}));

/** What GET /api/orders/[id] answered — the compose page reads it. */
const loaded = vi.hoisted(() => ({ order: null as OrderDTO | null }));

vi.mock("@/hooks/use-order-query", () => ({
  orderQueryKey: (orderId: string) => ["order", orderId] as const,
  useOrderQuery: () => ({
    data: loaded.order ?? undefined,
    error: null,
    isLoading: false,
  }),
}));

const mutations = vi.hoisted(() => ({
  capture: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
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

/** The composer asks for the organization's gateways and a live preview;
 *  neither answers, so nothing re-renders behind an assertion. */
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    api: { get: pending, post: pending, patch: pending, put: pending, del: pending },
  };
});

beforeAll(() => {
  // Radix measures and captures the pointer; jsdom implements none of it.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

/* ------------------------------------------------------------------ *
 * The order — an itinerary FLIGHT, as the order API serves it
 * ------------------------------------------------------------------ */

const AIRLINE_CHARGE = 400;
const COLLECTED = 100;
const CUSTOMER = "Grace Hopper";
const ORDER_NUMBER = "FLT-24001";

/** The label this change replaced — in any case, across any spacing. */
const SERVICE_CHARGE = /service\s*charge/i;

/** Two names per case: the label must follow what was STORED. */
const NEW_BOOKING_NAMES = ["Rental Cost", "Agency Fee"] as const;
const MODIFICATION_NAMES = ["Modification Fee", "Agency Fee"] as const;

function segment(
  origin: string,
  destination: string,
  departure: [date: string, time: string],
  arrival: [date: string, time: string],
  airline: string,
  flightNumber: string,
): OrderFlightSegment {
  return {
    origin,
    destination,
    departure: { date: departure[0], time: departure[1] },
    arrival: { date: arrival[0], time: arrival[1] },
    airline,
    flightNumber,
    details: null,
  };
}

/** Delhi → Varanasi → Mumbai, one way, with the airline charge in its own
 *  field. The legacy flat fields are null, as on every itinerary flight. */
const FLIGHT: OrderFlight = {
  tripType: FlightTripType.ONE_WAY,
  outbound: {
    segments: [
      segment("Delhi", "Varanasi", ["2026-10-10", "10:30"], ["2026-10-10", "12:00"], "Air India", "AI123"),
      segment("Varanasi", "Mumbai", ["2026-10-10", "14:30"], ["2026-10-10", "16:30"], "IndiGo", "6E456"),
    ],
    connections: [
      { layover: { location: null, durationMinutesOverride: null, notes: "Change terminals" } },
    ],
  },
  return: null,
  airlineFare: AIRLINE_CHARGE,
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

/** A manual-capture hold on the collected charge alone. */
function hold(status: PaymentCaptureStatus): OrderPaymentCapture {
  return {
    method: CaptureMode.MANUAL,
    status,
    authorizedAt: "2026-10-01T10:00:00.000Z",
    amountAuthorized: COLLECTED,
    captureExpiresAt: "2026-10-08T10:00:00.000Z",
    capturedAt: null,
    amountCaptured: null,
    cancelledAt: null,
    cancelReason: null,
    lastError: null,
  };
}

interface FlightOrderSeed {
  /** The operator's name for the one charge the link collects — stored as
   *  `charges[0].name`. */
  chargeName: string;
  bookingType?: BookingType;
  status?: OrderStatus;
  /** Null = automatic capture (no hold). */
  captureStatus?: PaymentCaptureStatus | null;
}

/**
 * The order DTO for a flight whose payment link collects ONE prepaid
 * $100.00 charge named `chargeName`, beside a $400.00 airline charge that
 * is never collected (`pricing.amount` is the charge alone).
 */
function flightOrder({
  chargeName,
  bookingType = BookingType.NEW_BOOKING,
  status = OrderStatus.PAYMENT_PENDING,
  captureStatus = null,
}: FlightOrderSeed): OrderDTO {
  const paid = status === OrderStatus.PAID;
  return {
    id: "665f1c2b9d3e4a0012345678",
    orderNumber: ORDER_NUMBER,
    bookingType,
    serviceType: ServiceType.FLIGHT,
    status,
    state: RecordState.ACTIVE,
    bookingStatus: captureStatus ? BookingStatus.PENDING : null,
    customer: { name: CUSTOMER, email: "grace@payops.test", phone: "+15555550101" },
    provider: {
      id: "AIRINDIA",
      name: "Air India",
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
    },
    vehicle: null,
    trip: null,
    flight: FLIGHT,
    hotel: null,
    pricing: { amount: COLLECTED, currency: Currency.USD },
    charges: [{ name: chargeName, amount: COLLECTED, timing: PaymentTiming.PREPAID }],
    confirmationNumber: null,
    terms: { text: "Flight terms.", version: "v1" },
    termsAcknowledgement: null,
    payment: {
      gateway: PaymentGatewayKey.STRIPE,
      paymentSessionId: "cs_test_named_charge",
      paymentUrl: "https://checkout.stripe.test/c/pay/cs_test_named_charge",
      paymentIntentId: null,
      status,
      paidAt: paid ? "2026-10-02T09:00:00.000Z" : null,
      expiresAt: "2026-10-03T09:00:00.000Z",
      amountReceived: paid ? COLLECTED : null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: "2026-10-01T09:00:00.000Z",
      capture: captureStatus ? hold(captureStatus) : null,
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

/**
 * The evidence chain the evidence page is handed for `order`, its flight
 * money worded as the server words it: `chargeName` (empty = neutral) and
 * `serviceChargeModel` (`flightEvidence` in the evidence service).
 */
function evidenceChain(
  order: OrderDTO,
  money: { chargeName: string; serviceChargeModel: boolean },
): OrderEvidenceChainWithFlightDTO {
  return {
    events: [],
    verification: {
      valid: true,
      eventCount: 0,
      brokenAtSequence: null,
      reason: null,
      headHash: null,
    },
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      customer: order.customer,
      pricing: order.pricing,
      status: order.status,
      state: order.state,
      provider: order.provider,
      serviceType: order.serviceType,
      vehicle: null,
      item: describeServiceItem(order),
      createdAt: order.createdAt,
    },
    flight: {
      itinerary: buildFlightItinerary(order.flight),
      details: serviceDetailRows(order),
      passengerNotes: null,
      amounts: summarizeFlightAmounts(
        order.charges,
        order.flight?.airlineFare,
        order.pricing.amount,
      ),
      serviceChargeModel: money.serviceChargeModel,
      chargeName: money.chargeName,
      collection: flightCollection(order),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rendering and reading
 * ------------------------------------------------------------------ */

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * What a reader sees in `el`: every text node in document order, one
 * space apart, whitespace collapsed — so a label and its amount in
 * neighbouring elements read "Rental Cost $100.00".
 */
function readText(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.nodeValue ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** A card by its title. */
function card(title: string): HTMLElement {
  const heading = screen
    .queryAllByRole("heading", { level: 3 })
    .find((el) => el.textContent === title);
  const found = heading?.closest<HTMLElement>('[data-slot="card"]');
  if (!found) throw new Error(`no "${title}" card`);
  return found;
}

/** The order detail page's charge breakdown block. */
function chargeBreakdown(): HTMLElement {
  const block = screen.getByText("Charge breakdown").parentElement;
  if (!block) throw new Error("no charge breakdown");
  return block;
}

/** The value printed beside a label (`<dt>`/`<dd>`, or label/value cells). */
function valueBeside(scope: HTMLElement, label: string): string {
  const el = within(scope).getByText(label, { exact: true });
  return el.nextElementSibling?.textContent ?? "";
}

/** The composer's four flight money rows, in order. */
function composerRows(name: string): string {
  return [
    "Airline Charge (not collected) $400.00",
    `${name} $100.00`,
    "Total Booking Value $500.00",
    "Amount Payable Now $100.00",
  ].join(" ");
}

/** Opens a dialog from its trigger and returns it. */
function openDialog(trigger: string, title: string | RegExp): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  return screen.getByRole("dialog", { name: title });
}

/** The capture dialog's "I have checked…" acknowledgement, as read. */
function captureAcknowledgement(dialog: HTMLElement): string {
  const label = within(dialog)
    .getByRole("checkbox", { name: "Confirm this capture" })
    .closest("label");
  return (label?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * A NEW BOOKING: every surface names the operator's charge
 * ------------------------------------------------------------------ */

describe.each(NEW_BOOKING_NAMES)(
  "an itinerary NEW BOOKING whose charge the operator named %s",
  (name) => {
    it("EmailComposer: the payment summary card's collected row is the stored name", () => {
      const order = flightOrder({ chargeName: name });
      renderWithQueryClient(
        <EmailComposer
          order={order}
          initialHtml=""
          defaultSubject={`Complete your Air India payment • ${ORDER_NUMBER}`}
        />,
      );

      const summary = card(ORDER_NUMBER);
      expect(readText(summary)).toContain(composerRows(name));
      expect(valueBeside(summary, name)).toBe("$100.00");
      expect(valueBeside(summary, "Airline Charge (not collected)")).toBe("$400.00");
      expect(valueBeside(summary, "Total Booking Value")).toBe("$500.00");
      expect(valueBeside(summary, "Amount Payable Now")).toBe("$100.00");
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("EmailComposePageContent: the order summary and the composer card both read the name", () => {
      const order = flightOrder({ chargeName: name });
      loaded.order = order;
      renderWithQueryClient(<EmailComposePageContent orderId={order.id} />);

      for (const title of ["Order summary", ORDER_NUMBER]) {
        const summary = card(title);
        expect(readText(summary), title).toContain(composerRows(name));
        expect(valueBeside(summary, name), title).toBe("$100.00");
      }
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("EmailComposePageContent: the default subject names the charge — never the airline", () => {
      const order = flightOrder({ chargeName: name });
      loaded.order = order;
      renderWithQueryClient(<EmailComposePageContent orderId={order.id} />);

      const subject = screen.getByLabelText("Subject") as HTMLInputElement;
      expect(subject.value).toBe(`Complete your ${name} payment • ${ORDER_NUMBER}`);
      expect(subject.value).not.toContain("Air India");
    });

    it("CapturePaymentDialog: the title, row, confirmation and button name the charge", () => {
      const order = flightOrder({
        chargeName: name,
        captureStatus: PaymentCaptureStatus.AUTHORIZED,
      });
      render(<CapturePaymentDialog order={order} />);

      const dialog = openDialog(
        "Capture payment",
        `Charge the $100.00 ${name} to this customer?`,
      );
      expect(valueBeside(dialog, `${name} to capture`)).toBe("$100.00");
      expect(captureAcknowledgement(dialog)).toBe(
        `I have checked the details above and want to charge the $100.00 ${name} to ${CUSTOMER} now.`,
      );
      expect(
        within(dialog).getByRole("button", { name: `Capture $100.00 ${name}` }),
      ).toBeDisabled();
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("CapturePaymentDialog: the toast after the capture names the charge", async () => {
      const order = flightOrder({
        chargeName: name,
        captureStatus: PaymentCaptureStatus.AUTHORIZED,
      });
      render(<CapturePaymentDialog order={order} />);

      const dialog = openDialog(
        "Capture payment",
        `Charge the $100.00 ${name} to this customer?`,
      );
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm this capture" }));
      fireEvent.click(within(dialog).getByRole("button", { name: `Capture $100.00 ${name}` }));

      await waitFor(() =>
        expect(toasts.success).toHaveBeenCalledWith(`Captured the $100.00 ${name}`),
      );
      expect(mutations.capture).toHaveBeenCalledTimes(1);
      expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it("ReleaseAuthorizationDialog: names the hold by the charge", () => {
      const order = flightOrder({
        chargeName: name,
        captureStatus: PaymentCaptureStatus.AUTHORIZED,
      });
      render(<ReleaseAuthorizationDialog order={order} />);

      const dialog = openDialog("Release hold", "Release the authorization?");
      expect(dialog).toHaveTextContent(
        `The $100.00 ${name} hold on ${CUSTOMER}'s card is released and the customer is NOT charged.`,
      );
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("PaymentStatusFloater: an in-flight capture names the authorized charge", () => {
      const order = flightOrder({
        chargeName: name,
        status: OrderStatus.PAYMENT_PENDING,
        captureStatus: PaymentCaptureStatus.CAPTURE_PENDING,
      });
      render(<PaymentStatusFloater order={order} />);

      const status = screen.getByRole("status");
      expect(readText(status)).toBe(
        `Capture in progress Charging the authorized ${name} now.`,
      );
      expect(status.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("OrderPaymentCard: the charge breakdown's collected row is the stored name", () => {
      const order = flightOrder({ chargeName: name });
      render(<OrderPaymentCard order={order} canRegenerate={false} />);

      expect(readText(chargeBreakdown())).toBe(
        [
          "Charge breakdown",
          "Airline Charge $400.00 Not collected through this payment link",
          `${name} $100.00`,
          "Total Booking Value $500.00",
          "Collected online Not collected yet",
        ].join(" "),
      );
      expect(valueBeside(chargeBreakdown(), name)).toBe("$100.00");
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("EvidenceChainView: the flight money rows use the evidence's chargeName", () => {
      const order = flightOrder({ chargeName: name, status: OrderStatus.PAID });
      render(
        <EvidenceChainView
          chain={evidenceChain(order, { chargeName: name, serviceChargeModel: true })}
          canExport={false}
        />,
      );

      const header = card("Order header");
      expect(readText(header)).toContain(
        [
          "Airline Charge $400.00 — not collected through this payment link",
          `${name} $100.00`,
          "Total Booking Value $500.00",
          "Collected online $100.00",
        ].join(" "),
      );
      expect(valueBeside(header, name)).toBe("$100.00");
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });
  },
);

describe("an evidence chain whose flight money is worded neutrally (chargeName '')", () => {
  it("EvidenceChainView: the collected row reads 'Charged Online'", () => {
    // An unnamed modification — its line still carries the pre-naming
    // marker — which `flightMoneyWording` words neutrally.
    const order = flightOrder({
      chargeName: "Service charge",
      bookingType: BookingType.MODIFICATION,
      status: OrderStatus.PAID,
    });
    render(
      <EvidenceChainView
        chain={evidenceChain(order, { chargeName: "", serviceChargeModel: false })}
        canExport={false}
      />,
    );

    const header = card("Order header");
    expect(readText(header)).toContain(
      [
        "Airline Charge $400.00 — not collected through this payment link",
        "Charged Online $100.00",
        "Total Booking Value $500.00",
        "Collected online $100.00",
      ].join(" "),
    );
    expect(valueBeside(header, "Charged Online")).toBe("$100.00");
    expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
  });
});

/* ------------------------------------------------------------------ *
 * A MODIFICATION: neutral sentences, named labels
 * ------------------------------------------------------------------ */

describe.each(MODIFICATION_NAMES)(
  "an itinerary MODIFICATION whose charge the operator named %s",
  (name) => {
    function heldModification(captureStatus: PaymentCaptureStatus): OrderDTO {
      return flightOrder({
        chargeName: name,
        bookingType: BookingType.MODIFICATION,
        captureStatus,
      });
    }

    it("CapturePaymentDialog keeps the neutral wording — title, row, confirmation and button", () => {
      render(<CapturePaymentDialog order={heldModification(PaymentCaptureStatus.AUTHORIZED)} />);

      const dialog = openDialog("Capture payment", "Charge $100.00 to this customer?");
      expect(valueBeside(dialog, "Amount to charge")).toBe("$100.00");
      expect(captureAcknowledgement(dialog)).toBe(
        `I have checked the details above and want to charge $100.00 to ${CUSTOMER} now.`,
      );
      expect(within(dialog).getByRole("button", { name: "Capture $100.00" })).toBeDisabled();
      expect(dialog.textContent).not.toContain(name);
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });

    it("ReleaseAuthorizationDialog keeps the neutral hold", () => {
      render(
        <ReleaseAuthorizationDialog order={heldModification(PaymentCaptureStatus.AUTHORIZED)} />,
      );

      const dialog = openDialog("Release hold", "Release the authorization?");
      expect(dialog).toHaveTextContent(
        `The $100.00 hold on ${CUSTOMER}'s card is released and the customer is NOT charged.`,
      );
      expect(dialog.textContent).not.toContain(name);
    });

    it("EmailComposePageContent: the default subject names the fee", () => {
      const order = flightOrder({ chargeName: name, bookingType: BookingType.MODIFICATION });
      loaded.order = order;
      renderWithQueryClient(<EmailComposePageContent orderId={order.id} />);

      expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
        `Complete your ${name} payment • ${ORDER_NUMBER}`,
      );
    });

    it("PaymentStatusFloater keeps the neutral noun", () => {
      render(
        <PaymentStatusFloater order={heldModification(PaymentCaptureStatus.CAPTURE_PENDING)} />,
      );

      expect(readText(screen.getByRole("status"))).toBe(
        "Capture in progress Charging the authorized amount now.",
      );
    });

    it("OrderPaymentCard labels the collected row with the stored name", () => {
      render(
        <OrderPaymentCard
          order={heldModification(PaymentCaptureStatus.AUTHORIZED)}
          canRegenerate={false}
        />,
      );

      expect(readText(chargeBreakdown())).toBe(
        [
          "Charge breakdown",
          "Airline Charge $400.00 Not collected through this payment link",
          `${name} $100.00`,
          "Total Booking Value $500.00",
          "Collected online On hold — not collected yet",
        ].join(" "),
      );
      expect(valueBeside(chargeBreakdown(), name)).toBe("$100.00");
      expect(document.body.textContent).not.toMatch(SERVICE_CHARGE);
    });
  },
);

/* ------------------------------------------------------------------ *
 * A car rental's composer subject — unchanged
 * ------------------------------------------------------------------ */

describe("a car rental in the composer", () => {
  it("keeps its default subject: 'Complete your <provider> payment • <order>'", () => {
    const flight = flightOrder({ chargeName: "Rental cost" });
    const car: OrderDTO = {
      ...flight,
      serviceType: ServiceType.CAR_RENTAL,
      provider: { ...flight.provider, id: "BUDGET", name: "Budget" },
      flight: null,
      vehicle: { company: "Toyota", type: "Camry" },
      trip: {
        pickupDate: "2026-10-10T15:00:00.000Z",
        dropoffDate: "2026-10-12T09:30:00.000Z",
        pickupLocation: "LAX Airport — Terminal 1",
        dropoffLocation: "San Diego Downtown",
      },
    };
    loaded.order = car;
    renderWithQueryClient(<EmailComposePageContent orderId={car.id} />);

    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe(
      `Complete your Budget payment • ${ORDER_NUMBER}`,
    );
  });
});
