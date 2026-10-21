import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ServiceTabs } from "@/components/features/orders/service-tabs";
import { ServiceType } from "@/lib/constants/enums";
import type { ProviderDTO } from "@/types";

/**
 * The multi-service create page: one tab per service the organization
 * sells, in the order the organization STORES them (its `serviceTypes`),
 * the first one open by default. A brand that lists car rental first opens
 * on car rental; one that lists flights first opens on flights.
 *
 * Every panel stays mounted (a half-filled form survives a peek at another
 * tab), but only the open one can submit: a hidden form — even a valid,
 * fully filled one — posts nothing until its tab is opened.
 *
 * No tab carries a terms notice. Terms need nothing from an admin: every
 * order freezes its own service's pre-written terms (the brand's own only
 * where it chose to customise them), so there is nothing to warn about and
 * no "Admin → Settings" errand for an agent.
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

// The catalog pickers read their catalogs over the network; a tab test
// needs neither.
vi.mock("@/components/features/hotels", () => ({
  HotelSelector: () => <div data-testid="hotel-catalog" />,
}));
vi.mock("@/components/features/car-links", () => ({
  CarLinkSelector: () => <div data-testid="car-link-library" />,
}));

function provider(key: string, name: string, serviceTypes: ServiceType[]): ProviderDTO {
  return {
    id: key.toLowerCase(),
    key,
    name,
    logo: "/logos/x.png",
    primaryColor: "#000000",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: "ACTIVE",
    serviceTypes,
    organizationIds: [],
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
  } as unknown as ProviderDTO;
}

const PROVIDERS = [
  provider("BUDGET", "Budget", [ServiceType.CAR_RENTAL]),
  provider("SKYAIR", "Sky Air", [ServiceType.FLIGHT]),
  provider("STAYCO", "Stay Co", [ServiceType.HOTEL]),
];

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

function renderTabs(
  serviceTypes: ServiceType[],
  extra: Partial<React.ComponentProps<typeof ServiceTabs>> = {},
) {
  return render(
    <ServiceTabs
      serviceTypes={serviceTypes}
      allowedBookingTypes={["NEW_BOOKING"]}
      defaultCurrency="USD"
      allowedCurrencies={["USD", "EUR"]}
      providers={PROVIDERS}
      {...extra}
    />,
  );
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const selectedTab = () =>
  screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")
    ?.textContent;

/** A service's panel, found by a card title only that service's form has. */
function panel(title: "Flights" | "Stay" | "Rental provider & vehicle"): HTMLElement {
  const heading = screen
    .queryAllByRole("heading", { level: 3, hidden: true })
    .find((el) => el.textContent === title);
  const found = heading?.closest('[role="tabpanel"]') as HTMLElement | null;
  if (!found) throw new Error(`no panel with a "${title}" card`);
  return found;
}

const SUBMIT = "Create order & generate link";

describe("tabs follow the organization's stored service order", () => {
  it("[FLIGHT, HOTEL, CAR_RENTAL] keeps today's order, flights open", () => {
    renderTabs([ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL]);
    expect(tabNames()).toEqual(["Flight", "Hotel", "Car rental"]);
    expect(selectedTab()).toBe("Flight");
    expect(panel("Flights")).not.toHaveAttribute("hidden");
    expect(panel("Stay")).toHaveAttribute("hidden");
  });

  it("[CAR_RENTAL, FLIGHT, HOTEL] puts car rental first and opens it", () => {
    renderTabs([ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL]);
    expect(tabNames()).toEqual(["Car rental", "Flight", "Hotel"]);
    expect(selectedTab()).toBe("Car rental");
    expect(panel("Flights")).toHaveAttribute("hidden");
    expect(panel("Stay")).toHaveAttribute("hidden");
    // The open panel is the car form's: the only actions row on screen.
    expect(panel("Rental provider & vehicle")).not.toHaveAttribute("hidden");
    const submits = screen.getAllByRole("button", { name: SUBMIT });
    expect(submits).toHaveLength(1);
    expect(submits[0]!.closest('[role="tabpanel"]')).toBe(panel("Rental provider & vehicle"));
  });

  it("[HOTEL, FLIGHT] opens on hotel", () => {
    renderTabs([ServiceType.HOTEL, ServiceType.FLIGHT]);
    expect(tabNames()).toEqual(["Hotel", "Flight"]);
    expect(selectedTab()).toBe("Hotel");
    expect(panel("Stay")).not.toHaveAttribute("hidden");
  });

  it("[CAR_RENTAL, FLIGHT] — no hotel capability — offers no Hotel tab and renders no hotel form", () => {
    renderTabs([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    expect(tabNames()).toEqual(["Car rental", "Flight"]);
    expect(screen.queryByRole("tab", { name: "Hotel" })).toBeNull();
    expect(() => panel("Stay")).toThrow(/no panel/);
  });

  it("[CAR_RENTAL, HOTEL] — no flight capability — offers no Flight tab and renders no flight form", () => {
    renderTabs([ServiceType.CAR_RENTAL, ServiceType.HOTEL]);
    expect(tabNames()).toEqual(["Car rental", "Hotel"]);
    expect(screen.queryByRole("tab", { name: "Flight" })).toBeNull();
    expect(() => panel("Flights")).toThrow(/no panel/);
  });

  it("lists a service stored twice once", () => {
    renderTabs([ServiceType.HOTEL, ServiceType.CAR_RENTAL, ServiceType.HOTEL]);
    expect(tabNames()).toEqual(["Hotel", "Car rental"]);
  });

  it("switches tabs without losing what was typed", async () => {
    renderTabs([ServiceType.CAR_RENTAL, ServiceType.HOTEL]);
    fireEvent.change(within(panel("Stay")).getByLabelText("Destination"), {
      target: { value: "Lisbon" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Hotel" }));
    await waitFor(() => expect(selectedTab()).toBe("Hotel"));
    expect(within(panel("Stay")).getByLabelText("Destination")).toHaveValue("Lisbon");
  });
});

describe("only the open tab can submit", () => {
  /** A complete, valid hotel request typed into the hotel panel. */
  function fillHotel(scope: HTMLElement) {
    const set = (label: string, value: string) =>
      fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
    set("Destination", "Lisbon");
    set("Check-in", "2026-10-17");
    set("Check-out", "2026-10-20");
    set("Full name", "Ada Lovelace");
    set("Email", "ada@payops.test");
    set("Phone", "+15555550101");
    set("Amount", "640");
  }

  it("a hidden, valid hotel form posts nothing — until its tab is opened", async () => {
    renderTabs([ServiceType.CAR_RENTAL, ServiceType.HOTEL]);
    const hotel = panel("Stay");
    expect(hotel).toHaveAttribute("hidden");
    expect(within(hotel).queryByRole("button", { name: SUBMIT, hidden: true })).toBeNull();

    fillHotel(hotel);
    await act(async () => {
      fireEvent.submit(hotel.querySelector("form")!);
    });
    // Let validation finish: had it failed, its messages would be here.
    await new Promise((r) => setTimeout(r, 50));
    expect(within(hotel).queryByText("Destination is required")).toBeNull();
    expect(posts).toHaveLength(0);

    // The same form, opened: it posts.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Hotel" }));
    await waitFor(() => expect(selectedTab()).toBe("Hotel"));
    await act(async () => {
      fireEvent.click(within(panel("Stay")).getByRole("button", { name: SUBMIT }));
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/orders");
    expect(posts[0]!.body).toMatchObject({ serviceType: "HOTEL", provider: "STAYCO" });
  });
});

describe("no terms notice: every tab's orders get their service's pre-written terms", () => {
  /** Everything the removed "built-in terms" notice said or pointed to. */
  const NOTICE_WORDING = [
    /of its own yet/i,
    /built-in/i,
    /terms in use/i,
    /will freeze/i,
    /Admin → Settings/,
    /ask an admin/i,
  ];

  /** Every panel, open or hidden — all of them are force-mounted. */
  const allPanels = () => screen.getAllByRole("tabpanel", { hidden: true });

  function expectNoNotice(container: HTMLElement) {
    for (const p of allPanels()) {
      for (const wording of NOTICE_WORDING) {
        expect(p.textContent ?? "").not.toMatch(wording);
      }
    }
    expect(container.textContent ?? "").not.toMatch(/of its own yet|built-in|Admin → Settings/i);
    // The notice linked to the settings page and rendered as an alert.
    expect(container.querySelector('a[href="/app/admin/settings"]')).toBeNull();
    expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
  }

  it.each([
    { label: "car rental · flight · hotel", serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL] },
    { label: "flight · hotel (no car tab at all)", serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL] },
    { label: "hotel · flight · car rental", serviceTypes: [ServiceType.HOTEL, ServiceType.FLIGHT, ServiceType.CAR_RENTAL] },
  ])("$label: no panel — open or hidden — carries a terms notice, a settings link or an alert", ({ serviceTypes }) => {
    const { container } = renderTabs(serviceTypes);
    expect(allPanels()).toHaveLength(serviceTypes.length);
    expectNoNotice(container);
  });

  it("opening each tab in turn shows its form and still no notice", async () => {
    const { container } = renderTabs([ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL]);
    for (const [tab, title] of [
      ["Flight", "Flights"],
      ["Hotel", "Stay"],
      ["Car rental", "Rental provider & vehicle"],
    ] as const) {
      fireEvent.mouseDown(screen.getByRole("tab", { name: tab }));
      await waitFor(() => expect(selectedTab()).toBe(tab));
      expect(panel(title)).not.toHaveAttribute("hidden");
      // The open form is ready to submit — nothing to set up first.
      expect(within(panel(title)).getByRole("button", { name: SUBMIT })).toBeInTheDocument();
      expectNoNotice(container);
    }
  });
});
