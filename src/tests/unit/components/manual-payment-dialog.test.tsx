import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  BookingType,
  ConsentStatus,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  api: { post },
}));

import { ManualPaymentDialog } from "@/components/features/orders/manual-payment-dialog";

/**
 * Recording a payment while money is already held. The operator says which
 * held payment is this order's payment — or that they refunded and took a
 * new one — and only that is sent. Before, one checkbox reconciled every
 * held payment and the dialog told them to charge the card on a terminal.
 */

function attempt(overrides: Record<string, unknown>) {
  return {
    gateway: "STRIPE",
    sessionId: "cs_old",
    paymentIntentId: "pi_old",
    amount: 500,
    currency: "USD",
    status: OrderStatus.PAID,
    failureReason: null,
    supersededReason: "GATEWAY_SWITCHED",
    supersededAt: "2026-09-16T10:00:00.000Z",
    held: true,
    heldReviewedAt: null,
    heldKind: "superseded-session",
    createdAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

function order(
  attempts: Array<Record<string, unknown>>,
  amount = 500,
  overrides: Record<string, unknown> = {},
): OrderDTO {
  return {
    id: "order-1",
    orderNumber: "ORD-1",
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.FAILED,
    state: RecordState.ACTIVE,
    provider: { id: "SIXT", name: "Sixt", logo: "", primaryColor: null, onPrimaryColor: null },
    customer: { name: "Jane Guest", email: "jane@example.com", phone: null },
    vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
    pricing: { amount, currency: "USD" },
    charges: [],
    risk: { flagged: true, flaggedNote: "held" },
    consent: { status: ConsentStatus.NOT_REQUESTED, collectionMethod: null },
    payment: {
      gateway: "PAYPAL",
      status: OrderStatus.FAILED,
      paymentUrl: null,
      paymentSessionId: "PAYPAL-1",
      paymentIntentId: null,
      paidAt: null,
      failureReason: null,
      attempts,
    },
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  } as unknown as OrderDTO;
}

function renderDialog(o: OrderDTO) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ManualPaymentDialog order={o} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /record manual payment/i }));
}

const submit = () => screen.getByRole("button", { name: /^record payment$/i });

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ order: order([]) });
});

describe("ManualPaymentDialog: a compact recording form", () => {
  it("leads with the amount, the order and the customer", () => {
    renderDialog(
      order([], 320, {
        consent: { status: ConsentStatus.VERIFIED, collectionMethod: "MANUAL" },
        risk: { flagged: false, flaggedNote: null },
      }),
    );
    expect(screen.getByText("Amount to collect")).toBeInTheDocument();
    expect(screen.getByText("$320.00")).toBeInTheDocument();
    expect(screen.getByText("ORD-1")).toBeInTheDocument();
    expect(screen.getByText("Jane Guest")).toBeInTheDocument();
    expect(screen.getByText(/customer consent verified/i)).toBeInTheDocument();
    // The safety rule stays, in one line.
    expect(
      screen.getByText(/Never enter card numbers, CVV, PINs/i),
    ).toBeInTheDocument();
  });

  it("does not repeat the order's payment history", () => {
    // Two dead links: history the order page already shows in full.
    renderDialog(
      order(
        [
          attempt({ held: false, status: OrderStatus.FAILED, sessionId: "cs_1" }),
          attempt({ held: false, status: OrderStatus.FAILED, sessionId: "cs_2" }),
        ],
        500,
        {
          consent: { status: ConsentStatus.VERIFIED, collectionMethod: "MANUAL" },
          risk: { flagged: false, flaggedNote: null },
        },
      ),
    );
    expect(screen.queryByText(/previous attempts/i)).toBeNull();
    expect(screen.queryByText(/payment status/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^record payment$/i })).toBeDisabled();
  });
});

describe("ManualPaymentDialog with held payments", () => {
  it("sends only the held payment the operator chose", async () => {
    renderDialog(
      order([
        attempt({}),
        attempt({ gateway: "PAYPAL", sessionId: "PAYPAL-1", paymentIntentId: "CAP-1" }),
      ]),
    );
    expect(submit()).toBeDisabled();
    // Nothing about charging a card while the operator is accepting money
    // already received.
    fireEvent.click(
      screen.getByRole("radio", {
        name: "The $500.00 already received on PayPal is this order's payment (refund the other one in its gateway)",
      }),
    );
    // Accepting money already received must not tell the operator to take
    // a new payment on a terminal.
    expect(screen.queryByText(/Never enter card numbers/i)).toBeNull();
    expect(screen.getByText(/Recording money already received/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/payment method/i)).toHaveValue("PayPal online payment");
    expect(screen.getByLabelText(/payment reference/i)).toHaveValue("CAP-1");

    fireEvent.click(submit());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1]).toMatchObject({
      method: "PayPal online payment",
      reference: "CAP-1",
      heldPaymentReviewed: true,
      acceptHeldPayment: { sessionId: "PAYPAL-1", paymentIntentId: "CAP-1" },
    });
  });

  it("a new payment after a refund needs the customer's confirmation", () => {
    renderDialog(order([attempt({})]));
    fireEvent.click(screen.getByRole("radio", { name: /refunded/i }));
    fireEvent.change(screen.getByLabelText(/payment reference/i), {
      target: { value: "AUTH-1" },
    });
    expect(submit()).toBeDisabled();
    expect(screen.getByLabelText(/payment method/i)).toHaveValue("Card terminal");
  });

  it("does not offer a held payment for a different amount", () => {
    renderDialog(order([attempt({ amount: 500 })], 575));
    const [accept] = screen.getAllByRole("radio");
    expect(accept).toBeDisabled();
    expect(screen.getByText(/not possible/i)).toBeInTheDocument();
  });
});
