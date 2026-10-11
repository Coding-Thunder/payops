import { describe, expect, it } from "vitest";

import { ServiceType } from "@/lib/constants/enums";
import { hotelNights } from "@/lib/service-summary";
import {
  createOrderRequestSchema,
  HOTEL_CHECK_OUT_BEFORE_CHECK_IN,
  HOTEL_MIN_ONE_NIGHT,
  calendarDaysBetween,
  hotelOrderSchema,
} from "@/lib/validation/order";
import { validHotelOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Hotel dates are CALENDAR DAYS.
 *
 * The create form sends "YYYY-MM-DD"; the order stores that day's UTC
 * midnight, and every surface shows the UTC day with no clock time. So a
 * stay is counted in calendar nights — check-out at least one day after
 * check-in — and a clock time can never add a night or lose one.
 */

function withDates(checkInDate: string, checkOutDate: string) {
  const base = validHotelOrderInput();
  return { ...base, hotel: { ...base.hotel, checkInDate, checkOutDate } };
}

function issuesOf(input: unknown) {
  const result = hotelOrderSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("hotelOrderSchema accepts the date-only days the create form sends", () => {
  it("accepts YYYY-MM-DD check-in and check-out, unchanged", () => {
    const result = hotelOrderSchema.safeParse(withDates("2026-10-17", "2026-10-20"));
    expect(result.success, JSON.stringify(issuesOf(withDates("2026-10-17", "2026-10-20")))).toBe(
      true,
    );
    if (!result.success) return;
    expect(result.data.hotel.checkInDate).toBe("2026-10-17");
    expect(result.data.hotel.checkOutDate).toBe("2026-10-20");
    // …which is that day's UTC midnight — what the order stores.
    expect(new Date(result.data.hotel.checkInDate).toISOString()).toBe(
      "2026-10-17T00:00:00.000Z",
    );
  });

  it("accepts a one-night stay — check-out the next calendar day", () => {
    expect(issuesOf(withDates("2026-10-17", "2026-10-18"))).toEqual([]);
  });

  it("goes through the API's service-type union the same way", () => {
    const result = createOrderRequestSchema.safeParse(withDates("2026-12-31", "2027-01-02"));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.serviceType).toBe(ServiceType.HOTEL);
  });

  it("still accepts the full timestamps an older client or API caller sends", () => {
    expect(
      issuesOf(withDates("2026-10-17T15:00:00.000Z", "2026-10-18T11:00:00.000Z")),
    ).toEqual([]);
  });

  it("still refuses a date that is not a date", () => {
    expect(issuesOf(withDates("2026-13-45", "2026-10-18"))).toContainEqual({
      path: "hotel.checkInDate",
      message: "Enter a valid date",
    });
  });
});

describe("hotelOrderSchema requires at least one night, by the calendar", () => {
  it("refuses check-out on the SAME day — a zero-night stay", () => {
    expect(issuesOf(withDates("2026-10-17", "2026-10-17"))).toEqual([
      { path: "hotel.checkOutDate", message: HOTEL_MIN_ONE_NIGHT },
    ]);
    expect(HOTEL_MIN_ONE_NIGHT).toBe("Check-out must be at least one night after check-in");
  });

  it("refuses a later clock time on the same day — which comparing instants let through", () => {
    expect(
      issuesOf(withDates("2026-10-17T09:00:00.000Z", "2026-10-17T21:00:00.000Z")),
    ).toEqual([{ path: "hotel.checkOutDate", message: HOTEL_MIN_ONE_NIGHT }]);
  });

  it("tells a check-out on an earlier day that it must come after check-in", () => {
    expect(issuesOf(withDates("2026-10-17", "2026-10-15"))).toEqual([
      { path: "hotel.checkOutDate", message: HOTEL_CHECK_OUT_BEFORE_CHECK_IN },
    ]);
    expect(HOTEL_CHECK_OUT_BEFORE_CHECK_IN).toBe("Check-out must be after check-in");
  });

  it("counts a late check-in and an early check-out on consecutive days as the one night it is", () => {
    // 11 hours apart by the clock, on two calendar days: one night.
    expect(
      issuesOf(withDates("2026-10-17T22:00:00.000Z", "2026-10-18T09:00:00.000Z")),
    ).toEqual([]);
  });
});

describe("calendarDaysBetween — a stay's nights, by the calendar", () => {
  it.each([
    ["2026-10-17", "2026-10-18", 1],
    ["2026-10-17", "2026-10-20", 3],
    ["2026-10-17", "2026-10-17", 0],
    ["2026-10-17", "2026-10-15", -2],
    // Month and year boundaries.
    ["2026-10-31", "2026-11-01", 1],
    ["2026-12-31", "2027-01-01", 1],
    // Clock times never add or lose a night.
    ["2026-10-17T01:00:00.000Z", "2026-10-19T23:00:00.000Z", 2],
    ["2026-10-17T22:00:00.000Z", "2026-10-18T09:00:00.000Z", 1],
  ])("%s → %s is %i night(s)", (checkIn, checkOut, nights) => {
    expect(calendarDaysBetween(checkIn, checkOut)).toBe(nights);
  });

  it("reads Dates exactly as it reads their ISO strings", () => {
    expect(calendarDaysBetween(new Date("2026-10-17"), new Date("2026-10-20"))).toBe(3);
  });

  it("is NaN for an unparseable date, never a number of nights", () => {
    expect(calendarDaysBetween("not a date", "2026-10-20")).toBeNaN();
  });

  it("counts every stay it accepts exactly as the surfaces display its nights", () => {
    // The rule that refuses a stay and the count every receipt prints must
    // never drift apart: same calendar days, the display never below one.
    for (const [checkInDate, checkOutDate] of [
      ["2026-10-17", "2026-10-18"],
      ["2026-10-17", "2026-10-20"],
      ["2026-12-31", "2027-01-02"],
      ["2026-10-17T01:00:00.000Z", "2026-10-19T23:00:00.000Z"],
      ["2026-10-17T22:00:00.000Z", "2026-10-18T09:00:00.000Z"],
    ]) {
      expect(hotelNights({ checkInDate, checkOutDate })).toBe(
        calendarDaysBetween(checkInDate, checkOutDate),
      );
    }
  });
});
