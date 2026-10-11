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
 *     UI — with the "Airline charge" field and ONE charge the payment link
 *     collects: its "Charge name" (prefilled "Service Charge") and its
 *     "Amount". No charge lines to add or remove, no timing choice and no
 *     rental wording anywhere;
 *   - the OPERATOR names that charge: the live summary labels the charge
 *     row and the footer sentence with the name being typed ("Rental
 *     Cost", "Processing Fee"…), a blank name reads "Service Charge", and
 *     the airline charge keeps its fixed label. A name that means the
 *     airline's amount is refused — the airline charge is never collected;
 *   - "+ Add Flight Segment" suggests the next From from the previous To,
 *     and that suggestion follows the previous To only while it is
 *     untouched — a From the operator typed is never overwritten;
 *   - an impossible connection is explained in the row between the two
 *     flights with the client's exact sentence, blocks the submit, and is
 *     shown ONCE (not again under the field);
 *   - what is posted is the normalised itinerary: one connection per gap,
 *     the layover override in minutes, the airline charge in its own field
 *     (`flight.airlineFare`) and ONE prepaid charge line — the operator's
 *     charge, under the name typed, for its amount alone.
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

const MONEY_CARD = "Airline charge & payment";

/** The money inputs: the airline charge, and the NAME and AMOUNT of the
 *  one charge the payment link collects. */
function money() {
  return {
    airline: field(card(MONEY_CARD), "Airline charge"),
    name: field(card(MONEY_CARD), "Charge name"),
    amount: field(card(MONEY_CARD), "Amount"),
  };
}

/** The money card's visible text — the live summary included. */
const moneyText = () => card(MONEY_CARD).textContent ?? "";

function fillCustomerAndCharge(chargeAmount: string, airlineCharge: string | null = "0") {
  type(within(card("Customer")).getByLabelText("Full name"), "Grace Hopper");
  type(within(card("Customer")).getByLabelText("Email"), "grace@example.com");
  type(within(card("Customer")).getByLabelText("Phone"), "+15555550101");
  if (airlineCharge !== null) type(money().airline, airlineCharge);
  type(money().amount, chargeAmount);
}

/** One direct flight, Delhi → Mumbai — a valid itinerary. */
function oneFlight() {
  fill(segment(flights(), 1)!, {
    from: "Delhi",
    to: "Mumbai",
    dd: "2026-10-10",
    dt: "10:30",
    ad: "2026-10-10",
    at: "12:30",
  });
}

/** What the posted body's money looks like. */
function postedMoney(i = 0) {
  const body = posts[i]!.body as {
    charges: { name: string; amount: number; timing: string }[];
    flight: { airlineFare: number };
  };
  return { charges: body.charges, airlineFare: body.flight.airlineFare };
}

const AIRLINE_NAME_MESSAGE =
  "The airline charge has its own field and is never collected here. Name the charge this link collects (e.g. Service Charge, Processing Fee).";

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
    // The airline charge, and ONE charge the link collects: its name
    // prefilled with the default, both amounts blank — nothing to add,
    // no second line, nothing to remove.
    expect(money().airline.value).toBe("");
    expect(money().name.value).toBe("Service Charge");
    expect(money().name.placeholder).toBe("e.g. Service Charge, Processing Fee");
    expect(money().name.maxLength).toBe(120);
    expect(money().amount.value).toBe("");
    expect(within(card(MONEY_CARD)).getAllByLabelText("Charge name")).toHaveLength(1);
    expect(within(card(MONEY_CARD)).getAllByLabelText("Amount")).toHaveLength(1);
    expect(within(card(MONEY_CARD)).queryByText("+ Add charge")).toBeNull();
    expect(within(card(MONEY_CARD)).queryByRole("button", { name: "Remove charge" })).toBeNull();
    expect(card(MONEY_CARD).textContent).toContain(
      "The payment link charges only the $0.00 Service Charge.",
    );
    expect(card("Airline / Supplier")).toBeTruthy();
  });
});

describe("CreateFlightOrderForm — the money", () => {
  it("shows the four rows live: airline charge + the charge (default name) = booking value, only the charge payable now", () => {
    renderForm();
    type(money().airline, "400");
    type(money().amount, "100");
    const box = card(MONEY_CARD).textContent ?? "";
    expect(box).toContain("Airline Charge");
    expect(box).toContain("Not collected through this payment link");
    expect(box).toContain("Service Charge$100.00");
    expect(box).toContain("Total Booking Value$500.00");
    expect(box).toContain("Amount Payable Now$100.00");
    expect(box).toContain(
      "Airline Charge is shown for the total booking value and is not collected through this payment link.",
    );
    expect(box).toContain("The payment link charges only the $100.00 Service Charge.");
  });

  it("leaves the airline row out for an airline charge of 0", () => {
    renderForm();
    type(money().airline, "0");
    type(money().amount, "75");
    const box = card(MONEY_CARD).textContent ?? "";
    expect(box).not.toContain("Airline Charge");
    expect(box).toContain("Total Booking Value$75.00");
    expect(box).toContain("Amount Payable Now$75.00");
  });

  it("refuses to post without an airline charge — 0 when there is none", async () => {
    renderForm();
    fill(segment(flights(), 1)!, {
      from: "Delhi",
      to: "Mumbai",
      dd: "2026-10-10",
      dt: "10:30",
      ad: "2026-10-10",
      at: "12:30",
    });
    fillCustomerAndCharge("50", null);
    await submit();
    expect(card(MONEY_CARD).textContent).toContain(
      "Enter the airline charge (0 if there is none)",
    );
    expect(posts).toHaveLength(0);

    type(money().airline, "0");
    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]!.body.flight as { airlineFare: number }).airlineFare).toBe(0);
    // The name left as prefilled is posted as the default.
    expect(posts[0]!.body.charges).toEqual([
      { name: "Service Charge", amount: 50, timing: "PREPAID" },
    ]);
  });
});

describe("CreateFlightOrderForm — the operator names the charge", () => {
  it.each(["Rental Cost", "Processing Fee", "Agency Fee"])(
    "a charge named %s: the live summary uses that name — row and footer — never 'Service Charge', and the submit posts it verbatim",
    async (name) => {
      renderForm();
      oneFlight();
      fillCustomerAndCharge("100", "400");
      type(money().name, name);

      const box = moneyText();
      // Exactly what the customer will see, in order: the airline charge
      // under its fixed label, then the operator's charge under its name.
      expect(box).toContain(
        "Airline ChargeNot collected through this payment link$400.00" +
          `${name}$100.00` +
          "Total Booking Value$500.00" +
          "Amount Payable Now$100.00" +
          "Airline Charge is shown for the total booking value and is not collected through this payment link." +
          `The payment link charges only the $100.00 ${name}.`,
      );
      expect(box.toLowerCase()).not.toContain("service charge");
      // The label is the charge's — never the customer's or the airline's.
      expect(box).not.toContain("Grace Hopper");
      expect(box).not.toContain("Sky Air");

      await submit();
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(postedMoney()).toEqual({
        charges: [{ name, amount: 100, timing: "PREPAID" }],
        airlineFare: 400,
      });
    },
  );

  it("renaming the charge relabels the summary at once — every amount, and what is posted, stays the same", async () => {
    renderForm();
    oneFlight();
    fillCustomerAndCharge("100", "400");
    type(money().name, "Rental Cost");
    expect(moneyText()).toContain("Rental Cost$100.00");
    expect(moneyText()).toContain("The payment link charges only the $100.00 Rental Cost.");

    type(money().name, "Processing Fee");
    const box = moneyText();
    expect(box).toContain("Processing Fee$100.00");
    expect(box).toContain("The payment link charges only the $100.00 Processing Fee.");
    expect(box).not.toContain("Rental Cost");
    expect(box).toContain("Airline ChargeNot collected through this payment link$400.00");
    expect(box).toContain("Total Booking Value$500.00");
    expect(box).toContain("Amount Payable Now$100.00");
    expect(money().amount.value).toBe("100");
    expect(money().airline.value).toBe("400");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(postedMoney()).toEqual({
      charges: [{ name: "Processing Fee", amount: 100, timing: "PREPAID" }],
      airlineFare: 400,
    });
  });

  it.each([
    ["cleared", ""],
    ["only spaces", "   "],
  ])(
    "a charge name %s reads — and is posted as — the default 'Service Charge'",
    async (_case, blank) => {
      renderForm();
      oneFlight();
      fillCustomerAndCharge("100", "400");
      type(money().name, "Processing Fee");
      type(money().name, blank);

      const box = moneyText();
      expect(box).toContain("Service Charge$100.00");
      expect(box).toContain("The payment link charges only the $100.00 Service Charge.");
      expect(box).not.toContain("Processing Fee");

      await submit();
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(postedMoney()).toEqual({
        charges: [{ name: "Service Charge", amount: 100, timing: "PREPAID" }],
        airlineFare: 400,
      });
    },
  );

  it.each(["Airline Charge", "airline fare"])(
    "refuses %s as the charge name — the airline charge is never collected — and posts nothing",
    async (name) => {
      renderForm();
      oneFlight();
      fillCustomerAndCharge("100", "400");
      type(money().name, name);
      await submit();

      await waitFor(() =>
        expect(money().name).toHaveAttribute("aria-invalid", "true"),
      );
      expect(posts).toHaveLength(0);
      // Said once, on the name field itself.
      expect(money().name).toHaveAccessibleDescription(
        expect.stringContaining(AIRLINE_NAME_MESSAGE),
      );
      expect(moneyText()).toContain(AIRLINE_NAME_MESSAGE);
      expect((document.body.textContent ?? "").split(AIRLINE_NAME_MESSAGE)).toHaveLength(2);

      // Named for what the link collects, the same order posts.
      type(money().name, "Processing Fee");
      await waitFor(() =>
        expect(money().name).toHaveAttribute("aria-invalid", "false"),
      );
      expect(document.body.textContent).not.toContain(AIRLINE_NAME_MESSAGE);
      await submit();
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(postedMoney()).toEqual({
        charges: [{ name: "Processing Fee", amount: 100, timing: "PREPAID" }],
        airlineFare: 400,
      });
    },
  );

  it("never puts the airline charge in the charges: it is posted on the flight, the charges carry the operator's amount alone", async () => {
    renderForm();
    oneFlight();
    fillCustomerAndCharge("100", "400");
    type(money().name, "Rental Cost");
    // The summary adds it into the booking value, not into what is paid now.
    expect(moneyText()).toContain("Total Booking Value$500.00");
    expect(moneyText()).toContain("Amount Payable Now$100.00");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    const { charges, airlineFare } = postedMoney();
    expect(airlineFare).toBe(400);
    // ONE line — the gateway's whole amount — for the operator's 100 only.
    expect(charges).toEqual([{ name: "Rental Cost", amount: 100, timing: "PREPAID" }]);
    expect(charges.reduce((sum, line) => sum + line.amount, 0)).toBe(100);
    expect(charges.some((line) => line.amount === 400 || line.amount === 500)).toBe(false);
    expect(charges.some((line) => /airline/i.test(line.name))).toBe(false);
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
  it("posts the normalised itinerary, the airline charge and ONE prepaid charge (default name)", async () => {
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
    expect(card(MONEY_CARD).textContent).toContain(
      "Not collected through this payment link",
    );
    expect(card(MONEY_CARD).textContent).toContain("$1,250.00");

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
      { name: "Service Charge", amount: 50, timing: "PREPAID" },
    ]);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/orders/ord_1/email"));
  });
});

describe("CreateFlightOrderForm — the PNR", () => {
  it("keeps the optional field and says it can be added later, on the order page", () => {
    renderForm();
    const pnr = within(card("Airline / Supplier")).getByLabelText(
      "PNR / record locator (optional)",
    );
    expect(pnr).toHaveAttribute("placeholder", "e.g. X4T9KP");
    expect(card("Airline / Supplier").textContent).toContain(
      "The airline booking reference. You can add or change it later on the order page; it appears at the top of the customer's confirmation email.",
    );
  });
});

describe("CreateFlightOrderForm — the charge's default name follows the booking type", () => {
  function renderWithTypes(allowedBookingTypes: string[]) {
    return render(
      <CreateFlightOrderForm
        allowedBookingTypes={allowedBookingTypes as never}
        defaultCurrency="USD"
        allowedCurrencies={["USD", "EUR"]}
        providers={PROVIDERS}
      />,
    );
  }

  async function chooseBookingType(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ) {
    await user.click(within(card("Trip")).getAllByRole("combobox")[0]!);
    await user.click(await screen.findByRole("option", { name: label }));
  }

  it("prefills each booking type's default, swapping it while it is untouched", async () => {
    const user = userEvent.setup();
    renderWithTypes(["NEW_BOOKING", "MODIFICATION", "CANCELLATION_CHARGE"]);
    type(money().airline, "400");
    type(money().amount, "95");
    expect(money().name.value).toBe("Service Charge");

    await chooseBookingType(user, "Modification");
    expect(money().name.value).toBe("Modification Fee");
    // A fee for the change is never called the Service Charge.
    expect(moneyText()).toContain("Modification Fee$95.00");
    expect(moneyText()).not.toContain("Service Charge");

    await chooseBookingType(user, "Cancellation charge");
    expect(money().name.value).toBe("Cancellation Charge");
    expect(moneyText()).toContain("Cancellation Charge$95.00");

    await chooseBookingType(user, "New booking");
    expect(money().name.value).toBe("Service Charge");
    expect(moneyText()).toContain("The payment link charges only the $95.00 Service Charge.");
  });

  it("never overwrites a name the operator typed", async () => {
    const user = userEvent.setup();
    renderWithTypes(["NEW_BOOKING", "MODIFICATION"]);
    type(money().amount, "95");
    type(money().name, "Date Change Fee");

    await chooseBookingType(user, "Modification");
    expect(money().name.value).toBe("Date Change Fee");
    expect(moneyText()).toContain("Date Change Fee$95.00");
    expect(moneyText()).not.toContain("Modification Fee");
  });

  it("starts on the first allowed booking type's default", () => {
    renderWithTypes(["MODIFICATION"]);
    expect(money().name.value).toBe("Modification Fee");
  });

  it("posts a modification left on its default as the Modification Fee — never a Service Charge", async () => {
    const user = userEvent.setup();
    renderWithTypes(["NEW_BOOKING", "MODIFICATION"]);
    await chooseBookingType(user, "Modification");
    oneFlight();
    fillCustomerAndCharge("95", "400");

    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.bookingType).toBe("MODIFICATION");
    expect(postedMoney()).toEqual({
      charges: [{ name: "Modification Fee", amount: 95, timing: "PREPAID" }],
      airlineFare: 400,
    });
  });

  it("previews the default — never a refused airline name — as the collected charge", () => {
    renderForm();
    type(money().airline, "400");
    type(money().amount, "100");
    type(money().name, "Airline Charge");

    // The airline row keeps its label; the collected row and the footer
    // never call the $100.00 the airline charge, even before the refusal
    // shows.
    expect(moneyText()).toContain("Service Charge$100.00");
    expect(moneyText()).toContain("The payment link charges only the $100.00 Service Charge.");
    expect(moneyText()).not.toContain("only the $100.00 Airline Charge");
    expect(moneyText().match(/Airline Charge/g)).toHaveLength(2); // the row + its explainer
  });
});
