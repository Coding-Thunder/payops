import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { OrderTable } from "@/components/features/orders/order-table";
import { PAID_FEATURES_ENABLED } from "@/lib/paid-features";
import {
  BookingType,
  ConsentStatus,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

/**
 * With the paid features off, none of their controls are on screen — not
 * disabled, absent. The implementation is untouched; only the flag decides.
 *
 * NB: no `vi.mock` of `@/lib/paid-features` here — this runs against the
 * real flag, exactly as the deployed app does.
 */

function order(overrides: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: "cccccccccccccccccccccc01",
    orderNumber: "ORD-OFF-1",
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.FAILED,
    state: RecordState.ACTIVE,
    provider: { id: "SIXT", name: "Sixt", logo: "", primaryColor: null, onPrimaryColor: null },
    customer: { name: "Jane Guest", email: "jane@example.com", phone: null },
    vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
    pricing: { amount: 500, currency: "USD" },
    charges: [],
    risk: { flagged: false, flaggedNote: null },
    consent: { status: ConsentStatus.VERIFIED, collectionMethod: "MANUAL" },
    createdBy: { userId: "u1", name: "Asha Verma", email: "asha@ops.test" },
    payment: {
      gateway: "STRIPE",
      status: OrderStatus.FAILED,
      paymentUrl: null,
      paymentSessionId: "cs_old",
      paymentIntentId: null,
      paidAt: null,
      failureReason: "Your card was declined.",
      attempts: [
        {
          gateway: "STRIPE",
          sessionId: "cs_old",
          paymentIntentId: "pi_old",
          amount: 500,
          currency: "USD",
          status: OrderStatus.FAILED,
          failureReason: "Your card was declined.",
          supersededReason: null,
          supersededAt: null,
          held: false,
          heldReviewedAt: null,
          heldKind: null,
          createdAt: "2026-09-16T09:00:00.000Z",
        },
      ],
    },
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  } as unknown as OrderDTO;
}

const paidCard = (o: OrderDTO) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OrderPaymentCard order={o} canRegenerate canManagePayment />
    </QueryClientProvider>,
  );

describe("paid features are off", () => {
  it("the switch is off", () => {
    expect(PAID_FEATURES_ENABLED).toBe(false);
  });

  it("the payment card offers no manual payment, no gateway switch, no attempt history", () => {
    paidCard(order());
    expect(screen.queryByRole("button", { name: /record manual payment/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /try another gateway|switch gateway/i })).toBeNull();
    expect(screen.queryByText(/payment attempts/i)).toBeNull();
    expect(screen.queryByText(/record a manual payment/i)).toBeNull();
    // What the old product showed is still there.
    expect(screen.getByText("Payment")).toBeInTheDocument();
    expect(screen.getByText(/Your card was declined\./)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate a new payment link/i }),
    ).toBeInTheDocument();
  });

  it("a manual request on the order does not turn the card into a manual one", () => {
    // Data from before the features were switched off must not resurface
    // their UI.
    paidCard(order({ consent: { status: ConsentStatus.VERIFIED, collectionMethod: "MANUAL" } } as Partial<OrderDTO>));
    expect(screen.queryByText(/manual requested/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /record manual payment/i })).toBeNull();
  });

  it("a held payment shows no reconciliation UI, and the card still reads as before", () => {
    paidCard(
      order({
        risk: { flagged: true, flaggedNote: "held" },
        payment: {
          ...order().payment,
          attempts: [
            {
              gateway: "STRIPE",
              sessionId: "cs_held",
              paymentIntentId: "pi_held",
              amount: 500,
              currency: "USD",
              status: OrderStatus.PAID,
              failureReason: null,
              supersededReason: "REGENERATED",
              supersededAt: "2026-09-16T10:00:00.000Z",
              held: true,
              heldReviewedAt: null,
              heldKind: "superseded-session",
              createdAt: "2026-09-16T09:30:00.000Z",
            },
          ],
        },
      } as unknown as Partial<OrderDTO>),
    );
    expect(screen.queryByText(/reconcile/i)).toBeNull();
    expect(screen.queryByText(/already received/i)).toBeNull();
    expect(screen.getByText("Payment")).toBeInTheDocument();
  });

  it("the orders table keeps selection for delete only: no export badge, paid rows not selectable", () => {
    const paid = order({
      id: "cccccccccccccccccccccc02",
      orderNumber: "ORD-OFF-2",
      status: OrderStatus.PAID,
    });
    render(<OrderTable items={[order(), paid]} selectable canDelete />);
    // A paid order is never deleted, so it is not selectable — as before.
    expect(
      screen.getByRole("checkbox", { name: "Select order ORD-OFF-2" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Select order ORD-OFF-1" }),
    ).toBeEnabled();
    expect(screen.queryByText("Payment held")).toBeNull();
  });
});
