import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OrderFilters } from "@/components/features/orders/order-filters";
import { ServiceType } from "@/lib/constants/enums";
import { renderWithUser, screen } from "@/tests/utils/render";

/**
 * The orders list's filter bar, now fed the selected organization's service
 * types.
 *
 * The incumbents' guarantee comes first: both car-rental brands resolve to
 * [CAR_RENTAL], and that must render EXACTLY the bar they had when the page
 * passed no service types at all — compared as static markup, not as "looks
 * similar". Only an organization with a genuine choice gets the service
 * filter, and an organization that sells flights alone must not be promised
 * a "vehicle" search.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const RENTAL_PLACEHOLDER = "Search by order, customer, phone, or vehicle";
const MULTI_SERVICE_PLACEHOLDER = "Search by order, customer, or phone";

describe("OrderFilters", () => {
  it("renders [CAR_RENTAL] byte-identically to passing no service types", () => {
    for (const canSeeAll of [true, false]) {
      const legacy = renderToStaticMarkup(<OrderFilters canSeeAll={canSeeAll} />);
      const car = renderToStaticMarkup(
        <OrderFilters canSeeAll={canSeeAll} serviceTypes={[ServiceType.CAR_RENTAL]} />,
      );
      expect(car).toBe(legacy);
      expect(car).toContain(`placeholder="${RENTAL_PLACEHOLDER}"`);
      // The comparison is sensitive: a multi-service bar does differ.
      expect(
        renderToStaticMarkup(
          <OrderFilters
            canSeeAll={canSeeAll}
            serviceTypes={[ServiceType.CAR_RENTAL, ServiceType.FLIGHT]}
          />,
        ),
      ).not.toBe(legacy);
    }
  });

  it("shows no service filter and keeps the vehicle placeholder for a car-only organization", () => {
    renderWithUser(
      <OrderFilters canSeeAll serviceTypes={[ServiceType.CAR_RENTAL]} />,
    );
    expect(screen.getByPlaceholderText(RENTAL_PLACEHOLDER)).toBeInTheDocument();
    // Status, booking type and owner — no service select.
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
  });

  it("never promises a 'vehicle' search to an organization that sells flights alone", () => {
    renderWithUser(<OrderFilters canSeeAll serviceTypes={[ServiceType.FLIGHT]} />);
    const search = screen.getByRole("textbox");
    expect(search).toHaveAttribute("placeholder", MULTI_SERVICE_PLACEHOLDER);
    expect(search.getAttribute("placeholder")!.toLowerCase()).not.toContain("vehicle");
    // One service only: nothing to choose between, so no service select.
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
  });

  it("adds the service filter when the organization sells more than one service", () => {
    renderWithUser(
      <OrderFilters
        canSeeAll
        serviceTypes={[ServiceType.CAR_RENTAL, ServiceType.FLIGHT]}
      />,
    );
    expect(screen.getByPlaceholderText(MULTI_SERVICE_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
  });
});
