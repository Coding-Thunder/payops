import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";

import { EmailComposer } from "@/components/features/orders/email-composer";
import {
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentStatus,
  Currency,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
} from "@/lib/constants/enums";
import { defaultPaymentRequestSubject } from "@/lib/payment-request-subject";
import type { OrderDTO } from "@/types";

/**
 * The payment-request composer's SUBJECT on a manual-capture order.
 *
 * The composer opens before the payment link exists, so its first default is
 * the payment subject; generating a manual-capture link (which refreshes the
 * order) turns the request into a card-authorization request. An untouched
 * subject must follow — "Authorize your card for your Budget booking • …" —
 * or the customer's inbox line would still ask for a payment the checkout
 * never takes. A subject the operator typed is theirs and never overwritten.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => "/app/orders",
  useSearchParams: () => new URLSearchParams(),
}));

/** No live events: the composer renders from the order alone. */
vi.mock("@/hooks/use-activity-feed", () => ({
  useActivityFeed: () => ({ events: [], push: () => {}, clear: () => {} }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const ORDER_NUMBER = "RC-261020-SUBJECT01";

/** A car order before its link (`linked` false) and once its manual-capture
 *  link exists (`linked` true: a PENDING_AUTHORIZATION capture record). */
function carOrder(linked: boolean): OrderDTO {
  return {
    id: "665f1c2b9d3e4a0000000201",
    orderNumber: ORDER_NUMBER,
    bookingType: BookingType.NEW_BOOKING,
    serviceType: ServiceType.CAR_RENTAL,
    status: linked ? OrderStatus.LINK_GENERATED : OrderStatus.NOT_INITIATED,
    state: RecordState.ACTIVE,
    bookingStatus: linked ? BookingStatus.PENDING : null,
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
      pickupDate: "2026-10-27T15:00:00.000Z",
      dropoffDate: "2026-10-30T09:30:00.000Z",
      pickupLocation: "LAX Airport — Terminal 1",
      dropoffLocation: "San Diego Downtown",
    },
    flight: null,
    hotel: null,
    pricing: { amount: 249.99, currency: Currency.USD },
    charges: [{ name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID }],
    confirmationNumber: null,
    terms: { text: "Rental terms.", version: "v1" },
    termsAcknowledgement: null,
    payment: {
      gateway: linked ? PaymentGatewayKey.STRIPE : null,
      paymentSessionId: linked ? "cs_test_subject01" : null,
      paymentUrl: linked ? "https://checkout.stripe.com/c/pay/cs_test_subject01" : null,
      paymentIntentId: null,
      status: linked ? OrderStatus.LINK_GENERATED : OrderStatus.NOT_INITIATED,
      paidAt: null,
      expiresAt: linked ? "2026-10-21T09:05:00.000Z" : null,
      amountReceived: null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: linked ? "2026-10-20T09:05:00.000Z" : null,
      capture: linked
        ? {
            method: CaptureMode.MANUAL,
            status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
            authorizedAt: null,
            amountAuthorized: null,
            captureExpiresAt: null,
            capturedAt: null,
            amountCaptured: null,
            cancelledAt: null,
            cancelReason: null,
            lastError: null,
          }
        : null,
    },
    createdBy: {
      userId: "665f1c2b9d3e4a00000000aa",
      name: "Olivia Operator",
      email: "olivia@payops.test",
    },
    policy: { acceptedAt: "2026-10-20T09:00:00.000Z", version: "v1", text: "Policy." },
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
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
  } as OrderDTO;
}

/** What the compose page passes: the order's own default subject. */
function subjectFor(order: OrderDTO): string {
  return defaultPaymentRequestSubject(
    order,
    "rental",
    order.payment.capture?.method === CaptureMode.MANUAL,
  );
}

function composer(order: OrderDTO) {
  return (
    <EmailComposer order={order} initialHtml="" defaultSubject={subjectFor(order)} />
  );
}

function renderComposer(order: OrderDTO) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{composer(order)}</QueryClientProvider>);
  return {
    ...view,
    rerenderWith: (next: OrderDTO) =>
      view.rerender(<QueryClientProvider client={client}>{composer(next)}</QueryClientProvider>),
  };
}

const subjectField = () =>
  screen.getByDisplayValue(/payment •|booking •|Operator's own/) as HTMLInputElement;

describe("the composer's subject on a manual-capture order", () => {
  it("the shared default asks for a payment before the link, and for a card authorization once a manual link exists", () => {
    expect(subjectFor(carOrder(false))).toBe(`Complete your Budget payment • ${ORDER_NUMBER}`);
    expect(subjectFor(carOrder(true))).toBe(
      `Authorize your card for your Budget booking • ${ORDER_NUMBER}`,
    );
  });

  it("an untouched subject follows the default when the link is generated (the order refreshes)", () => {
    const { rerenderWith } = renderComposer(carOrder(false));
    expect(subjectField().value).toBe(`Complete your Budget payment • ${ORDER_NUMBER}`);

    rerenderWith(carOrder(true));

    expect(subjectField().value).toBe(
      `Authorize your card for your Budget booking • ${ORDER_NUMBER}`,
    );
  });

  it("a subject the operator typed is theirs: it survives the link being generated", () => {
    const { rerenderWith } = renderComposer(carOrder(false));
    fireEvent.change(subjectField(), { target: { value: "Operator's own subject" } });

    rerenderWith(carOrder(true));

    expect(subjectField().value).toBe("Operator's own subject");
  });
});
