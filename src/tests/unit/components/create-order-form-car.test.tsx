import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import type { ProviderDTO } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
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

/**
 * The CAR create form, pinned to the words it has always shown.
 *
 * Its charge lines come from the shared `ChargeLinesFieldset`, which now
 * also serves the hotel form (its own timing labels, placeholder and
 * total) — every one of those is an optional prop whose DEFAULT is the
 * rental wording. This pins those defaults as a car operator sees them, so
 * a hotel-side change can never leak into the car form unnoticed.
 */

const PROVIDERS = [
  {
    id: "p1",
    key: "HERTZ",
    name: "Hertz",
    logo: "/logos/hertz.png",
    primaryColor: "#FFD100",
    onPrimaryColor: "#000000",
    tagline: "",
    status: "ACTIVE",
    serviceTypes: ["CAR_RENTAL"],
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

function renderCarForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateOrderForm
        allowedBookingTypes={["NEW_BOOKING"]}
        defaultCurrency="USD"
        allowedCurrencies={["USD", "EUR"]}
        providers={PROVIDERS}
      />
    </QueryClientProvider>,
  );
}

describe("CreateOrderForm (car rental) — the words it has always shown", () => {
  it("prefills a prepaid 'Rental cost' line with the rental placeholder and the rental timing words", () => {
    const { container } = renderCarForm();
    const nameInputs = Array.from(container.querySelectorAll("input")).filter(
      (el) => el.getAttribute("placeholder") === "e.g. Rental cost",
    );
    expect(nameInputs.length).toBeGreaterThan(0);
    expect((nameInputs[0] as HTMLInputElement).value).toBe("Rental cost");
    const text = container.textContent ?? "";
    expect(text).toContain("Prepaid");
    expect(text).not.toContain("Paid online now");
    expect(text).not.toContain("Due at the property");
  });

  it("totals the lines in rental words — never a hotel's or a flight's", () => {
    const { container } = renderCarForm();
    const text = container.textContent ?? "";
    expect(text).toContain("Amount paid online (today)");
    expect(text).toContain("Total rental cost");
    for (const foreign of [
      "Total hotel cost",
      "at the property",
      "Hotel / Supplier",
      "Airline",
      "Airline / Supplier",
      "Room charge",
      "Total Booking Value",
    ]) {
      expect(text, foreign).not.toContain(foreign);
    }
  });

  it("keeps the car's own supplier wording", () => {
    renderCarForm();
    expect(screen.queryByText("Hotel / Supplier")).toBeNull();
    expect(within(document.body).queryByText("Airline / Supplier")).toBeNull();
  });
});
