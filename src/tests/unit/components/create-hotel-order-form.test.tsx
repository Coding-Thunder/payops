import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreateHotelOrderForm } from "@/components/features/orders/create-hotel-order-form";
import type { ProviderDTO } from "@/types";

/**
 * The operator's hotel request form, driven through the DOM.
 *
 *   - Check-in and check-out are CALENDAR DAYS: date-only inputs, posted
 *     as "YYYY-MM-DD" — never an instant in the agent's time zone, which
 *     would land on another day for a customer (or a server) elsewhere.
 *   - Its money is worded for a hotel: a line is "Paid online now" or
 *     "Due at the property", the total is the "Total hotel cost", and
 *     nothing mentions a rental, a vehicle or a counter.
 *   - The supplier picker lists hotels & suppliers.
 *   - A form whose tab is not open never posts, however complete.
 */

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace,
    refresh: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// The catalog picker reads the hotel catalog over the network.
vi.mock("@/components/features/hotels", () => ({
  HotelSelector: () => <div data-testid="hotel-catalog" />,
}));

const PROVIDERS = [
  {
    id: "p1",
    key: "STAYCO",
    name: "Stay Co",
    logo: "/logos/stay.png",
    primaryColor: "#000000",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: "ACTIVE",
    serviceTypes: ["HOTEL"],
    organizationIds: [],
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
  },
] as unknown as ProviderDTO[];

beforeAll(() => {
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

function renderForm(active?: boolean) {
  return render(
    <CreateHotelOrderForm
      allowedBookingTypes={["NEW_BOOKING"]}
      defaultCurrency="USD"
      allowedCurrencies={["USD", "EUR"]}
      providers={PROVIDERS}
      active={active}
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

function set(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** A complete, valid request: 17 → 20 October, one prepaid line. */
function fillValid() {
  set("Destination", "Lisbon");
  set("Check-in", "2026-10-17");
  set("Check-out", "2026-10-20");
  set("Full name", "Ada Lovelace");
  set("Email", "ada@payops.test");
  set("Phone", "+15555550101");
  set("Amount", "640");
}

const SUBMIT = "Create order & generate link";

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
  });
}

describe("check-in and check-out are calendar days", () => {
  it("are date-only inputs", () => {
    renderForm();
    expect(screen.getByLabelText("Check-in")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Check-out")).toHaveAttribute("type", "date");
  });

  it("posts the days picked as YYYY-MM-DD — no clock time, no time zone", async () => {
    renderForm();
    fillValid();
    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    const hotel = posts[0]!.body.hotel as Record<string, unknown>;
    expect(hotel.checkInDate).toBe("2026-10-17");
    expect(hotel.checkOutDate).toBe("2026-10-20");
    expect(posts[0]!.body).toMatchObject({ serviceType: "HOTEL", provider: "STAYCO" });
    expect(replace).toHaveBeenCalledWith("/app/orders/ord_1/email");
  });

  it("offers check-out from the night after check-in", () => {
    renderForm();
    set("Check-in", "2026-10-31");
    expect(screen.getByLabelText("Check-out")).toHaveAttribute("min", "2026-11-01");
  });
});

describe("the money is worded for a hotel", () => {
  it("names a line's timing for a hotel, and the total as the hotel cost", async () => {
    const user = userEvent.setup();
    renderForm();
    const money = card("Charge details");
    expect(within(money).getByLabelText("Charge name")).toHaveAttribute(
      "placeholder",
      "e.g. Room charge",
    );
    expect(within(money).getByLabelText("Payment timing")).toHaveTextContent(
      "Paid online now",
    );
    expect(money.textContent).toContain("Amount due at the property");
    expect(money.textContent).toContain("Total hotel cost");

    await user.click(within(money).getByLabelText("Payment timing"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Paid online now", "Due at the property"]);
  });

  it("never mentions a rental, a vehicle or a counter", () => {
    const { container } = renderForm();
    expect(container.textContent).not.toMatch(/rental|vehicle|counter|Total stay cost/i);
  });

  it("posts a due-at-the-property line with the timing the server knows", async () => {
    const user = userEvent.setup();
    renderForm();
    fillValid();
    fireEvent.click(within(card("Charge details")).getByText("+ Add charge"));
    const names = within(card("Charge details")).getAllByPlaceholderText("e.g. Room charge");
    fireEvent.change(names[1]!, { target: { value: "City tax" } });
    const amounts = within(card("Charge details")).getAllByPlaceholderText("0.00");
    fireEvent.change(amounts[1]!, { target: { value: "25.5" } });
    const timings = within(card("Charge details")).getAllByRole("combobox");
    // [currency, line 1 timing, line 2 timing]
    await user.click(timings[2]!);
    await user.click(await screen.findByRole("option", { name: "Due at the property" }));
    await submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.charges).toEqual([
      { name: "Room charge", amount: 640, timing: "PREPAID" },
      { name: "City tax", amount: 25.5, timing: "DUE_AT_COUNTER" },
    ]);
  });
});

describe("the supplier picker", () => {
  it("lists hotels & suppliers — not rental providers", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(within(card("Hotel / Supplier")).getByRole("combobox"));
    expect(await screen.findByText("Hotels & suppliers")).toBeInTheDocument();
    expect(screen.queryByText("Rental providers")).toBeNull();
  });
});

describe("a form whose tab is not open", () => {
  it("shows no actions row and posts nothing, however complete", async () => {
    const { container } = renderForm(false);
    expect(screen.queryByRole("button", { name: SUBMIT })).toBeNull();
    fillValid();
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    await new Promise((r) => setTimeout(r, 50));
    // Validation passed (no messages), so only the closed tab held it back.
    expect(screen.queryByText("Destination is required")).toBeNull();
    expect(screen.queryByText("Check-out must be after check-in")).toBeNull();
    expect(posts).toHaveLength(0);
  });
});
