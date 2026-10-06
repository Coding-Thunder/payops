import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreateFlightOrderForm } from "@/components/features/orders/create-flight-order-form";
import { CONNECTION_CHRONOLOGY_MESSAGE } from "@/lib/flight-itinerary";
import type { ProviderDTO } from "@/types";

/**
 * The operator's flight order form, driven through the DOM.
 *
 * The rules pinned here are the client's, from the form's side:
 *
 *   - a new booking starts as ONE direct flight — no connection, no layover
 *     UI — priced as a prepaid "Service charge" with no timing choice and no
 *     rental wording anywhere;
 *   - "+ Add Flight Segment" suggests the next From from the previous To,
 *     and that suggestion follows the previous To only while it is
 *     untouched — a From the operator typed is never overwritten;
 *   - an impossible connection is explained in the row between the two
 *     flights with the client's exact sentence, blocks the submit, and is
 *     shown ONCE (not again under the field);
 *   - what is posted is the normalised itinerary: one connection per gap,
 *     the layover override in minutes, the airline fare, PREPAID charges.
 */

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
    refresh,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const toastWarning = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: (m: string) => toastWarning(m),
  },
}));

const PROVIDERS = [
  {
    id: "p1",
    key: "SKYAIR",
    name: "Sky Air",
    logo: "/logos/sky.png",
    primaryColor: "#000000",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: "ACTIVE",
    serviceTypes: ["FLIGHT"],
    organizationIds: [],
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
  },
] as unknown as ProviderDTO[];

beforeAll(() => {
  // Radix Select measures and captures the pointer; jsdom implements none
  // of it.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

let posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts = [];
  replace.mockReset();
  refresh.mockReset();
  toastWarning.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ ok: true, data: { order: { id: "ord_1" }, checkoutUrl: "" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------- helpers ---------------------------- */

function renderForm() {
  return render(
    <CreateFlightOrderForm
      allowedBookingTypes={["NEW_BOOKING"]}
      defaultCurrency="USD"
      allowedCurrencies={["USD", "EUR"]}
      providers={PROVIDERS}
    />,
  );
}

/** A card by its title. */
function card(title: string): HTMLElement {
  const heading = screen
    .queryAllByRole("heading", { level: 3 })
    .find((el) => el.textContent === title);
  const found = heading?.closest('[data-slot="card"]') as HTMLElement | null;
  if (!found) throw new Error(`no "${title}" card`);
  return found;
}

/** The "Flight N" segment card within a journey. */
function segment(journey: HTMLElement, n: number): HTMLElement | null {
  const heading = within(journey)
    .queryAllByRole("heading", { level: 4 })
    .find((el) => el.textContent?.endsWith(`Flight ${n}`));
  return (heading?.closest("li") as HTMLElement | null) ?? null;
}

function field(scope: HTMLElement, label: string): HTMLInputElement {
  return within(scope).getByLabelText(label, { exact: true }) as HTMLInputElement;
}

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

function fill(
  seg: HTMLElement,
  v: { from?: string; to?: string; dd?: string; dt?: string; ad?: string; at?: string },
) {
  if (v.from !== undefined) type(field(seg, "From"), v.from);
  if (v.to !== undefined) type(field(seg, "To"), v.to);
  if (v.dd !== undefined) type(field(seg, "Departure date"), v.dd);
  if (v.dt !== undefined) type(field(seg, "Departure time"), v.dt);
  if (v.ad !== undefined) type(field(seg, "Arrival date"), v.ad);
  if (v.at !== undefined) type(field(seg, "Arrival time"), v.at);
}

function connections(journey: HTMLElement): HTMLElement[] {
  return within(journey)
    .queryAllByRole("listitem")
    .filter((li) => li.getAttribute("aria-label")?.startsWith("Connection between"));
}

const flights = () => card("Flights");

/** Delhi → Varanasi, then a second flight added with the suggested From. */
function twoFlights() {
  fill(segment(flights(), 1)!, {
    from: "Delhi",
    to: "Varanasi",
    dd: "2026-10-10",
    dt: "10:30",
    ad: "2026-10-10",
    at: "12:00",
  });
  fireEvent.click(within(flights()).getByText("+ Add Flight Segment"));
  fill(segment(flights(), 2)!, {
    to: "Mumbai",
    dd: "2026-10-10",
    dt: "14:30",
    ad: "2026-10-10",
    at: "16:30",
  });
}

function fillCustomerAndCharge(serviceCharge: string, airlineFare?: string) {
  type(within(card("Customer")).getByLabelText("Full name"), "Grace Hopper");
  type(within(card("Customer")).getByLabelText("Email"), "grace@example.com");
  type(within(card("Customer")).getByLabelText("Phone"), "+15555550101");
  // Two money inputs share the "0.00" placeholder: the airline fare first,
  // then the service-charge amount.
  const amounts = within(card("Fare & service charge")).getAllByPlaceholderText(
    "0.00",
  ) as HTMLInputElement[];
  if (airlineFare !== undefined) type(amounts[0]!, airlineFare);
  type(amounts[1]!, serviceCharge);
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create order & generate link" }));
  });
}

/* ----------------------------- tests ----------------------------- */

describe("CreateFlightOrderForm — a new booking", () => {
  it("starts as one direct flight, prepaid, with no rental wording", () => {
    const { container } = renderForm();
    const text = container.textContent ?? "";

    expect(segment(flights(), 1)).not.toBeNull();
    expect(segment(flights(), 2)).toBeNull();
    // A direct flight shows no connection and no layover UI at all.
    expect(connections(flights())).toHaveLength(0);
    expect(within(flights()).queryByText("+ Add Layover")).toBeNull();
    expect(
      within(segment(flights(), 1)!).getByRole("button", { name: "Delete flight 1" }),
    ).toBeDisabled();

    expect(text).not.toMatch(/rental|vehicle|Pick-up|Drop-off|counter/i);
    expect(text).not.toContain("Payment timing");
    expect(text).not.toContain("Due at");
    expect(
      (within(card("Fare & service charge")).getByPlaceholderText(
        "e.g. Service charge",
      ) as HTMLInputElement).value,
    ).toBe("Service charge");
    expect(card("Fare & service charge").textContent).toContain(
      "The payment link charges only the $0.00 service charge.",
    );
    expect(card("Airline / Supplier")).toBeTruthy();
  });
});

describe("CreateFlightOrderForm — the From suggestion", () => {
  it("pre-fills the new flight's From with the previous To and focuses its To", async () => {
    renderForm();
    fill(segment(flights(), 1)!, { from: "Delhi", to: "Varanasi" });
    fireEvent.click(within(flights()).getByText("+ Add Flight Segment"));

    const second = segment(flights(), 2)!;
    expect(field(second, "From").value).toBe("Varanasi");
    await waitFor(() => expect(document.activeElement).toBe(field(second, "To")));
    // Two flights: one connection between them, offering a layover.
    expect(connections(flights())).toHaveLength(1);
    expect(within(connections(flights())[0]!).getByText("+ Add Layover")).toBeTruthy();
  });

  it("follows an untouched suggestion, but never overwrites a From the operator typed", () => {
    renderForm();
    twoFlights();
    const first = () => segment(flights(), 1)!;
    const second = () => segment(flights(), 2)!;

    type(field(first(), "To"), "Varanasi Intl");
    expect(field(second(), "From").value).toBe("Varanasi Intl");

    type(field(second(), "From"), "VNS");
    type(field(first(), "To"), "Varanasi");
    expect(field(second(), "From").value).toBe("VNS");
  });
});

describe("CreateFlightOrderForm — editing an earlier flight", () => {
  it("keeps every keystroke typed into an earlier flight's To (its card never remounts)", async () => {
    const user = userEvent.setup();
    renderForm();
    twoFlights();
    const firstTo = field(segment(flights(), 1)!, "To");

    await user.clear(firstTo);
    await user.type(firstTo, "Lucknow");

    // The same input, still in the document, with the whole word in it.
    expect(field(segment(flights(), 1)!, "To")).toBe(firstTo);
    expect(firstTo.value).toBe("Lucknow");
    // The untouched suggestion followed it, keystroke by keystroke.
    expect(field(segment(flights(), 2)!, "From").value).toBe("Lucknow");
  });

  it("follows the suggestion whatever spacing the previous To was typed with", () => {
    renderForm();
    fill(segment(flights(), 1)!, { from: "Delhi", to: "Varanasi " });
    fireEvent.click(within(flights()).getByText("+ Add Flight Segment"));
    expect(field(segment(flights(), 2)!, "From").value).toBe("Varanasi");

    type(field(segment(flights(), 1)!, "To"), "Lucknow");
    expect(field(segment(flights(), 2)!, "From").value).toBe("Lucknow");
  });
});

describe("CreateFlightOrderForm — an impossible connection", () => {
  it("explains it in the connection row, blocks the submit, and says it once", async () => {
    renderForm();
    twoFlights();
    const row = () => connections(flights())[0]!;
    expect(row().textContent).toContain(
      "Lands Varanasi 12:00 PM · next departs 2:30 PM · 2h 30m",
    );

    // Flight 2 now leaves before flight 1 lands.
    type(field(segment(flights(), 2)!, "Departure time"), "11:00");
    expect(row().textContent).toContain(CONNECTION_CHRONOLOGY_MESSAGE);

    fillCustomerAndCharge("50");
    await submit();
    await new Promise((r) => setTimeout(r, 20));

    expect(posts).toHaveLength(0);
    const page = document.body.textContent ?? "";
    expect(page.split(CONNECTION_CHRONOLOGY_MESSAGE).length - 1).toBe(1);
    expect(field(segment(flights(), 2)!, "Departure date")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    // Fixed: the message and the flag both go.
    type(field(segment(flights(), 2)!, "Departure time"), "14:30");
    await waitFor(() =>
      expect(field(segment(flights(), 2)!, "Departure date")).toHaveAttribute(
        "aria-invalid",
        "false",
      ),
    );
    expect(document.body.textContent).not.toContain(CONNECTION_CHRONOLOGY_MESSAGE);
  });
});

describe("CreateFlightOrderForm — a multi-city trip of one flight", () => {
  it("blocks the submit with the journey-level message, then posts once a second flight is added", async () => {
    const user = userEvent.setup();
    renderForm();
    fill(segment(flights(), 1)!, {
      from: "Delhi",
      to: "Varanasi",
      dd: "2026-10-10",
      dt: "10:30",
      ad: "2026-10-10",
      at: "12:00",
    });

    await user.click(within(card("Trip")).getAllByRole("combobox")[1]!);
    await user.click(await screen.findByRole("option", { name: "Multi-city" }));
    const journey = () => card("Multi-city flights");
    expect(journey().textContent).toContain("A multi-city trip needs at least two flights.");

    fillCustomerAndCharge("50");
    await submit();
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(0);
    const page = document.body.textContent ?? "";
    expect(page.split("A multi-city trip needs at least two flights.").length - 1).toBe(1);

    fireEvent.click(within(journey()).getByText("+ Add Flight Segment"));
    fill(segment(journey(), 2)!, {
      to: "Mumbai",
      dd: "2026-10-12",
      dt: "08:00",
      ad: "2026-10-12",
      at: "10:05",
    });
    expect(journey().textContent).not.toContain("A multi-city trip needs at least two flights.");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    const flight = posts[0]!.body.flight as { tripType: string; return: unknown };
    expect(flight.tripType).toBe("MULTI_CITY");
    expect(flight.return).toBeNull();
  });
});

describe("CreateFlightOrderForm — a layover's errors go with the layover", () => {
  it("clears an invalid override when the layover is removed, and a re-added layover starts clean", async () => {
    renderForm();
    twoFlights();
    const row = () => connections(flights())[0]!;
    fireEvent.click(within(row()).getByText("+ Add Layover"));
    fireEvent.click(within(row()).getByRole("checkbox", { name: "Override duration" }));
    type(within(row()).getByLabelText("Hours"), "0");
    type(within(row()).getByLabelText("Minutes"), "0");

    fillCustomerAndCharge("50");
    await submit();
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(0);
    expect(row().textContent).toContain("Enter a duration of at least 1 minute");

    fireEvent.click(within(row()).getByText("Remove layover"));
    expect(document.body.textContent).not.toContain("Enter a duration of at least 1 minute");

    fireEvent.click(within(row()).getByText("+ Add Layover"));
    expect(document.body.textContent).not.toContain("Enter a duration of at least 1 minute");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    const outbound = (posts[0]!.body.flight as {
      outbound: { connections: { layover: { durationMinutesOverride: number | null } | null }[] };
    }).outbound;
    expect(outbound.connections[0]!.layover).toMatchObject({ durationMinutesOverride: null });
  });
});

describe("CreateFlightOrderForm — a valid order", () => {
  it("posts the normalised itinerary, the fare and a PREPAID service charge", async () => {
    renderForm();
    twoFlights();

    // A layover on the connection, with its duration overridden to 3h 5m.
    const row = () => connections(flights())[0]!;
    fireEvent.click(within(row()).getByText("+ Add Layover"));
    expect(row().textContent).toContain("Calculated: 2h 30m");
    fireEvent.click(within(row()).getByRole("checkbox", { name: "Override duration" }));
    expect((within(row()).getByLabelText("Hours") as HTMLInputElement).value).toBe("2");
    expect((within(row()).getByLabelText("Minutes") as HTMLInputElement).value).toBe("30");
    type(within(row()).getByLabelText("Hours"), "3");
    type(within(row()).getByLabelText("Minutes"), "5");
    type(within(row()).getByLabelText("Layover notes (optional)"), "Change terminals");

    fillCustomerAndCharge("50", "1200");
    expect(card("Fare & service charge").textContent).toContain(
      "Charged separately — not part of this payment",
    );
    expect(card("Fare & service charge").textContent).toContain("$1,250.00");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));

    const { url, body } = posts[0]!;
    expect(url).toBe("/api/orders");
    const flight = body.flight as {
      tripType: string;
      return: unknown;
      airlineFare: number;
      outbound: {
        segments: { origin: string; departure: { date: string; time: string } }[];
        connections: { layover: { durationMinutesOverride: number; notes: string } | null }[];
      };
    };
    expect(body.serviceType).toBe("FLIGHT");
    expect(flight.tripType).toBe("ONE_WAY");
    expect(flight.return).toBeNull();
    expect(flight.outbound.segments.map((s) => s.origin)).toEqual(["Delhi", "Varanasi"]);
    expect(flight.outbound.segments[0]!.departure).toEqual({ date: "2026-10-10", time: "10:30" });
    expect(flight.outbound.connections).toHaveLength(1);
    expect(flight.outbound.connections[0]!.layover).toMatchObject({
      durationMinutesOverride: 185,
      notes: "Change terminals",
    });
    expect(flight.airlineFare).toBe(1200);
    expect(body.charges).toEqual([
      { name: "Service charge", amount: 50, timing: "PREPAID" },
    ]);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/orders/ord_1/email"));
  });
});
