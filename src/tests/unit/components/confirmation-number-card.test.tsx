import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";

import { ConfirmationNumberCard } from "@/components/features/orders/confirmation-number-card";
import { orderQueryKey, useOrderQuery } from "@/hooks/use-order-query";
import {
  BookingType,
  ConsentStatus,
  Currency,
  FlightTripType,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
} from "@/lib/constants/enums";
import type { OrderDTO, OrderFlight, OrderHotel } from "@/types";

/**
 * The order page's booking-reference card — ONE reference per order
 * (`order.confirmationNumber`), named the way each service names it: a
 * car's "Confirmation number" exactly as it has always read, a flight's
 * "PNR", a hotel's "Hotel confirmation number".
 *
 * What it shows is the order's reference (`bookingReference`), so a flight
 * created before the PNR lived on the order shows its legacy `flight.pnr`.
 * A save writes the order the API answers with straight into the order
 * query cache — the page renders from that cache, so the card settles
 * (hint gone, Save disabled, Reset hidden) without a reload. Saving never
 * resends the confirmation email; only the explicit button does.
 *
 * The network is the order API, emulated below: the confirmation-number
 * route answers with the fresh order, the resend route with
 * `{ order, emailId }`.
 */

const router = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({ toast: toasts }));

const ORDER_ID = "665f1c2b9d3e4a0012345678";
const RESENT_AT = "2026-10-09T12:00:00.000Z";

/** A car rental order as the order API serves it. */
function carOrder(over: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: ORDER_ID,
    orderNumber: "RC-10001",
    bookingType: BookingType.NEW_BOOKING,
    serviceType: ServiceType.CAR_RENTAL,
    status: OrderStatus.NOT_INITIATED,
    state: RecordState.ACTIVE,
    bookingStatus: null,
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550101" },
    provider: {
      id: "BUDGET",
      name: "Budget",
      logo: "/providers/budget.png",
      primaryColor: "#000000",
      onPrimaryColor: "#FFFFFF",
    },
    vehicle: { company: "Toyota", type: "Corolla", imageUrl: null },
    trip: {
      pickupDate: "2026-10-17T15:00:00.000Z",
      dropoffDate: "2026-10-20T09:30:00.000Z",
      pickupLocation: null,
      dropoffLocation: null,
    },
    flight: null,
    hotel: null,
    pricing: { amount: 150, currency: Currency.USD },
    charges: [{ name: "Rental cost", amount: 150, timing: PaymentTiming.PREPAID }],
    confirmationNumber: null,
    terms: { text: "Terms.", version: "v1" },
    termsAcknowledgement: null,
    payment: {
      gateway: PaymentGatewayKey.STRIPE,
      paymentSessionId: null,
      paymentUrl: null,
      paymentIntentId: null,
      status: OrderStatus.NOT_INITIATED,
      paidAt: null,
      expiresAt: null,
      amountReceived: null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: null,
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
    ...over,
  } as OrderDTO;
}

/** A PAID order whose confirmation email already went out — the only
 *  state that offers a resend (and that the page does not poll). */
function paid(order: OrderDTO): OrderDTO {
  return {
    ...order,
    status: OrderStatus.PAID,
    payment: {
      ...order.payment,
      status: OrderStatus.PAID,
      paidAt: "2026-10-02T09:00:00.000Z",
      amountReceived: order.pricing.amount,
      confirmationEmailSentAt: "2026-10-02T09:00:05.000Z",
    },
  };
}

const ITINERARY_FLIGHT: OrderFlight = {
  tripType: FlightTripType.ONE_WAY,
  outbound: {
    segments: [
      {
        origin: "Delhi",
        destination: "Mumbai",
        departure: { date: "2026-10-17", time: "10:30" },
        arrival: { date: "2026-10-17", time: "12:45" },
        airline: "Air India",
        flightNumber: "AI101",
        details: null,
      },
    ],
    connections: [],
  },
  return: null,
  airlineFare: 400,
  cabinClass: "ECONOMY",
  passengers: { adults: 1, children: 0, infants: 0 },
  passengerNotes: null,
  pnr: null,
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

function flightOrder(over: Partial<OrderFlight> = {}, order: Partial<OrderDTO> = {}): OrderDTO {
  return carOrder({
    serviceType: ServiceType.FLIGHT,
    vehicle: null,
    trip: null,
    flight: { ...ITINERARY_FLIGHT, ...over },
    charges: [{ name: "Service Charge", amount: 100, timing: PaymentTiming.PREPAID }],
    ...order,
  });
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

function hotelOrder(order: Partial<OrderDTO> = {}): OrderDTO {
  return carOrder({
    serviceType: ServiceType.HOTEL,
    vehicle: null,
    trip: null,
    hotel: HOTEL,
    charges: [{ name: "Room charge", amount: 640, timing: PaymentTiming.PREPAID }],
    ...order,
  });
}

/* ------------------------------------------------------------------ *
 * The order API, emulated
 * ------------------------------------------------------------------ */

/** What the server holds. Each route answers from (and writes) it. */
let stored: OrderDTO;
let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[];

function respond(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
      calls.push({ method, url, body });
      if (method === "POST" && url === `/api/orders/${ORDER_ID}/confirmation-number`) {
        const next = String(body?.confirmationNumber ?? "").trim() || null;
        stored = { ...stored, confirmationNumber: next };
        return respond(stored);
      }
      if (method === "POST" && url === `/api/orders/${ORDER_ID}/resend-confirmation`) {
        stored = {
          ...stored,
          payment: { ...stored.payment, confirmationEmailSentAt: RESENT_AT },
        };
        return respond({ order: stored, emailId: "msg_resent_1" });
      }
      if (method === "GET" && url === `/api/orders/${ORDER_ID}`) {
        return respond(stored);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
}

let client: QueryClient;

beforeEach(() => {
  calls = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

function withClient(ui: React.ReactElement) {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** The card on its own, handed one order. */
function renderCard(order: OrderDTO) {
  serve(order);
  return render(withClient(<ConfirmationNumberCard order={order} />));
}

/** The card the way the order page mounts it: fed by the order query, so
 *  whatever the card writes to the cache is what it is rendered with. */
function OrderPage() {
  const { data } = useOrderQuery(ORDER_ID);
  return data ? <ConfirmationNumberCard order={data} /> : null;
}

/** Mounts the page and waits for its first fetch to finish, as it has long
 *  before an agent gets to type. */
async function renderPage(order: OrderDTO) {
  serve(order);
  client.setQueryData(orderQueryKey(ORDER_ID), order);
  const view = render(withClient(<OrderPage />));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return view;
}

function cached(): OrderDTO {
  return client.getQueryData<OrderDTO>(orderQueryKey(ORDER_ID))!;
}

const input = () => screen.getByRole("textbox") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });
const resetButton = () => screen.queryByRole("button", { name: "Reset" });

function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

/* ------------------------------------------------------------------ *
 * CAR — today's words, byte for byte
 * ------------------------------------------------------------------ */

const CAR_DESCRIPTION =
  "Paste the supplier confirmation number. It appears at the top of the customer's confirmation email.";
const CAR_RESEND_HELP =
  "The confirmation email was sent automatically on payment. If you've added or changed the confirmation number since, resend it so the customer receives the updated copy.";

describe("CAR_RENTAL — the card reads exactly as it always has", () => {
  it("title, description, placeholder and the not-set hint", () => {
    renderCard(carOrder());
    expect(screen.getByRole("heading", { name: "Confirmation number" })).toBeInTheDocument();
    expect(screen.getByText(CAR_DESCRIPTION)).toBeInTheDocument();
    expect(input()).toHaveAttribute("placeholder", "e.g. ABC-12345678");
    expect(input()).toHaveAttribute("maxLength", "64");
    expect(input()).toHaveValue("");
    expect(screen.getByText("No confirmation number set yet.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeNull();
  });

  it("an order stored before service types existed reads as a car", () => {
    renderCard(carOrder({ serviceType: undefined as unknown as ServiceType }));
    expect(screen.getByRole("heading", { name: "Confirmation number" })).toBeInTheDocument();
    expect(input()).toHaveAttribute("placeholder", "e.g. ABC-12345678");
  });

  it("toasts 'Confirmation number saved' and posts the trimmed value", async () => {
    renderCard(carOrder());
    type("  ABC-12345678 ");
    expect(resetButton()).not.toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Confirmation number saved"),
    );
    expect(calls).toEqual([
      {
        method: "POST",
        url: `/api/orders/${ORDER_ID}/confirmation-number`,
        body: { confirmationNumber: "ABC-12345678" },
      },
    ]);
  });

  it("toasts 'Confirmation number cleared' when the field is emptied", async () => {
    renderCard(carOrder({ confirmationNumber: "ABC-12345678" }));
    expect(input()).toHaveValue("ABC-12345678");
    expect(screen.queryByText("No confirmation number set yet.")).toBeNull();
    type("");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Confirmation number cleared"),
    );
    expect(calls[0]!.body).toEqual({ confirmationNumber: "" });
  });

  it("keeps its fallback error wording", async () => {
    serve(carOrder());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    render(withClient(<ConfirmationNumberCard order={carOrder()} />));
    type("ABC-1");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not save the confirmation number"),
    );
  });

  it("offers the resend on a paid order, worded as before", () => {
    renderCard(paid(carOrder({ confirmationNumber: "ABC-12345678" })));
    expect(screen.getByText(CAR_RESEND_HELP)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resend confirmation email" }),
    ).toBeInTheDocument();
    type("ABC-87654321");
    expect(
      screen.getByText(`${CAR_RESEND_HELP} Resending will save your current change first.`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save & resend confirmation email" }),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * FLIGHT and HOTEL — each names its own reference
 * ------------------------------------------------------------------ */

describe("each service names its reference its own way", () => {
  it("a flight's is the PNR", () => {
    renderCard(flightOrder());
    expect(screen.getByRole("heading", { name: "PNR" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste the airline booking reference (PNR). It appears at the top of the customer's confirmation email.",
      ),
    ).toBeInTheDocument();
    expect(input()).toHaveAttribute("placeholder", "e.g. X4T9KP");
    expect(screen.getByText("No PNR set yet.")).toBeInTheDocument();
    expect(screen.queryByText(/confirmation number/i)).toBeNull();
  });

  it("a flight created before the PNR lived on the order shows its legacy PNR as the current value", () => {
    renderCard(flightOrder({ pnr: "QX7T2L" }));
    expect(input()).toHaveValue("QX7T2L");
    expect(screen.queryByText("No PNR set yet.")).toBeNull();
    // Nothing to save: the field shows exactly what the order holds.
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeNull();
  });

  it("an older flight holding a DIFFERENT legacy PNR edits its pasted supplier number, under the name it was entered with", () => {
    renderCard(flightOrder({ pnr: "QX7T2L" }, { confirmationNumber: "AXXXYY" }));
    expect(input()).toHaveValue("AXXXYY");
    // The airline PNR is shown on its own; this card is the supplier's
    // confirmation number, as it always was for this order.
    expect(screen.getByText("Confirmation number")).toBeInTheDocument();
    expect(screen.getByText(CAR_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText("PNR")).toBeNull();
  });

  it("clearing an older flight's pasted supplier number says it was cleared — and the card falls back to its airline PNR", async () => {
    await renderPage(flightOrder({ pnr: "QX7T2L" }, { confirmationNumber: "AXXXYY" }));
    type("");
    fireEvent.click(saveButton());
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Confirmation number cleared"));
    await waitFor(() => expect(input()).toHaveValue("QX7T2L"));
    expect(screen.getByText("PNR")).toBeInTheDocument();
  });

  it("a flight's resend help names the PNR", () => {
    renderCard(paid(flightOrder({}, { confirmationNumber: "AXXXYY" })));
    expect(
      screen.getByText(
        "The confirmation email was sent automatically on payment. If you've added or changed the PNR since, resend it so the customer receives the updated copy.",
      ),
    ).toBeInTheDocument();
  });

  it("a hotel's is the hotel confirmation number", async () => {
    renderCard(hotelOrder());
    expect(
      screen.getByRole("heading", { name: "Hotel confirmation number" }),
    ).toBeInTheDocument();
    expect(input()).toHaveAttribute("placeholder", "e.g. 83920174");
    expect(screen.getByText("No hotel confirmation number set yet.")).toBeInTheDocument();
    type("83920174");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Hotel confirmation number saved"),
    );
  });

  it("no flight or hotel copy says 'rental' or 'counter'", () => {
    for (const order of [flightOrder(), hotelOrder(), paid(hotelOrder({ confirmationNumber: "1" }))]) {
      const { container, unmount } = renderCard(order);
      expect(container.textContent!.toLowerCase()).not.toMatch(/rental|counter|vehicle/);
      unmount();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The cache contract — no reload
 * ------------------------------------------------------------------ */

describe("a save lands in the order cache — the card settles without a reload", () => {
  it("after Save the not-set hint is gone, Save is disabled and Reset hidden", async () => {
    await renderPage(flightOrder());
    expect(screen.getByText("No PNR set yet.")).toBeInTheDocument();
    type("AXXXYY");
    expect(resetButton()).not.toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.queryByText("No PNR set yet.")).toBeNull());
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeNull();
    expect(input()).toHaveValue("AXXXYY");
    expect(cached().confirmationNumber).toBe("AXXXYY");
    expect(toasts.success).toHaveBeenCalledWith("PNR saved");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("settles on the saved value when the agent typed stray spaces", async () => {
    await renderPage(carOrder());
    type("  ABC-1 ");
    fireEvent.click(saveButton());
    await waitFor(() => expect(cached().confirmationNumber).toBe("ABC-1"));
    expect(input()).toHaveValue("ABC-1");
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeNull();
  });

  it("clearing works: the hint comes back and nothing is left to save", async () => {
    await renderPage(hotelOrder({ confirmationNumber: "83920174" }));
    expect(screen.queryByText("No hotel confirmation number set yet.")).toBeNull();
    type("");
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("No hotel confirmation number set yet.")).toBeInTheDocument(),
    );
    expect(cached().confirmationNumber).toBeNull();
    expect(saveButton()).toBeDisabled();
    expect(resetButton()).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Hotel confirmation number cleared");
  });

  it("a poll still in flight cannot put the old reference back", async () => {
    await renderPage(carOrder());
    const served = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        if ((init.method ?? "GET") !== "GET") return served(url, init);
        // Answered late, with the order as it was when it was asked for.
        const stale = served(url, init);
        return new Promise<Response>((resolve) => {
          release = () => resolve(stale);
        });
      }),
    );
    // A poll goes out…
    void client.refetchQueries({ queryKey: orderQueryKey(ORDER_ID) });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    // …the agent saves while it is out…
    type("ABC-1");
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Confirmation number saved"),
    );
    // …and it comes back afterwards, carrying the order from before the save.
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(cached().confirmationNumber).toBe("ABC-1");
    expect(input()).toHaveValue("ABC-1");
    expect(screen.queryByText("No confirmation number set yet.")).toBeNull();
  });

  it("follows a reference saved elsewhere — arriving with a poll — unless the agent is mid-edit", async () => {
    await renderPage(carOrder());
    /** A poll, and the re-render it brings (React Query notifies its
     *  observers on the next tick). */
    async function poll() {
      await act(async () => {
        await client.refetchQueries({ queryKey: orderQueryKey(ORDER_ID) });
        await new Promise((r) => setTimeout(r, 10));
      });
    }

    // Another agent saves it; the next poll brings it in.
    stored = { ...stored, confirmationNumber: "XYZ-9" };
    await poll();
    expect(input()).toHaveValue("XYZ-9");
    expect(saveButton()).toBeDisabled();
    expect(screen.queryByText("No confirmation number set yet.")).toBeNull();

    // Mid-edit, what the agent typed stays…
    type("MINE-1");
    stored = { ...stored, confirmationNumber: "XYZ-10" };
    await poll();
    expect(cached().confirmationNumber).toBe("XYZ-10");
    expect(input()).toHaveValue("MINE-1");
    // …and Reset goes back to what is stored now.
    fireEvent.click(resetButton()!);
    expect(input()).toHaveValue("XYZ-10");
    expect(resetButton()).toBeNull();
  });

  it("saving never resends the confirmation email", async () => {
    await renderPage(paid(carOrder()));
    type("ABC-1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(cached().confirmationNumber).toBe("ABC-1"));
    expect(calls.map((c) => `${c.method} ${c.url}`)).not.toContain(
      `POST /api/orders/${ORDER_ID}/resend-confirmation`,
    );
  });

  it("a resend writes the order it answers with into the cache", async () => {
    await renderPage(paid(flightOrder({}, { confirmationNumber: "AXXXYY" })));
    fireEvent.click(screen.getByRole("button", { name: "Resend confirmation email" }));

    await waitFor(() =>
      expect(cached().payment.confirmationEmailSentAt).toBe(RESENT_AT),
    );
    expect(toasts.success).toHaveBeenCalledWith(
      "Confirmation email resent to the customer",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("'Save & resend' saves first, then resends, and the card settles", async () => {
    await renderPage(paid(hotelOrder()));
    type("83920174");
    fireEvent.click(
      screen.getByRole("button", { name: "Save & resend confirmation email" }),
    );

    await waitFor(() =>
      expect(cached().payment.confirmationEmailSentAt).toBe(RESENT_AT),
    );
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `/api/orders/${ORDER_ID}/confirmation-number`,
      `/api/orders/${ORDER_ID}/resend-confirmation`,
    ]);
    expect(cached().confirmationNumber).toBe("83920174");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resend confirmation email" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("No hotel confirmation number set yet.")).toBeNull();
  });
});
