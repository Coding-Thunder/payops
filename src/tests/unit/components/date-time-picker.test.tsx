import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DateTimePicker } from "@/components/common/date-time-picker";

/**
 * Which days the pick-up and drop-off pickers actually let you choose.
 *
 * Both fields render the same `DateTimePicker`, so everything here is
 * exercised through that one component with the `minDate` each field
 * supplies:
 *
 *   pick-up   minDate = midnight today          → today and everything after
 *   drop-off  minDate = the selected pick-up    → the pick-up day and after
 *
 * The interesting case is the month boundary. React-day-picker fills the
 * last row of a month grid with the first days of the NEXT month, and those
 * "outside" days are rendered in a muted grey that reads as disabled. These
 * tests assert the DOM state — the `disabled` attribute on the day button —
 * rather than anything about colour, because the two are independent and it
 * is the DOM that decides whether a date can be picked.
 *
 * The clock is pinned to 27 Aug 2026 so "next month" is a fixed, real
 * boundary rather than whatever today happens to be.
 */

const TODAY = new Date(2026, 7, 27, 9, 30); // Thu 27 Aug 2026, local time
const MIDNIGHT_TODAY = new Date(2026, 7, 27, 0, 0, 0, 0);

/** The day cell for a given date in the currently displayed month grid.
 *  Outside days carry the same accessible name, so the grid is narrowed to
 *  the row set first via the aria-label react-day-picker puts on each day. */
function dayButton(label: string): HTMLButtonElement {
  const grid = screen.getByRole("grid");
  const cell = within(grid)
    .getAllByRole("gridcell")
    .map((td) => td.querySelector("button"))
    .filter((b): b is HTMLButtonElement => b !== null)
    .find((b) => (b.getAttribute("aria-label") ?? "").includes(label));
  if (!cell) throw new Error(`No day button matching "${label}" in the grid`);
  return cell;
}

async function openPicker(minDate: Date) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <DateTimePicker
      id="under-test"
      value=""
      onChange={() => {}}
      minDate={minDate}
      placeholder="Select"
    />,
  );
  await user.click(screen.getByRole("button", { name: /select/i }));
  await screen.findByRole("grid");
  return user;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pick-up: minDate is midnight today", () => {
  it("disables yesterday", async () => {
    await openPicker(MIDNIGHT_TODAY);
    expect(dayButton("August 26th, 2026")).toBeDisabled();
  });

  it("enables today", async () => {
    await openPicker(MIDNIGHT_TODAY);
    expect(dayButton("August 27th, 2026")).toBeEnabled();
  });

  it("enables tomorrow", async () => {
    await openPicker(MIDNIGHT_TODAY);
    expect(dayButton("August 28th, 2026")).toBeEnabled();
  });

  it("enables the last day of the current month", async () => {
    await openPicker(MIDNIGHT_TODAY);
    expect(dayButton("August 31st, 2026")).toBeEnabled();
  });

  /** The reported bug. Sep 1 renders inside the August grid as an outside
   *  day, greyed — but grey is styling, and this asserts the DOM. */
  it("enables the first day of NEXT month while still showing August", async () => {
    await openPicker(MIDNIGHT_TODAY);
    expect(dayButton("September 1st, 2026")).toBeEnabled();
  });

  it("enables a date far in the future once navigated to", async () => {
    const user = await openPicker(MIDNIGHT_TODAY);
    await user.click(screen.getByRole("button", { name: /next month/i }));
    expect(dayButton("September 15th, 2026")).toBeEnabled();
  });

  it("applies no upper bound — no maxDate is configured anywhere", async () => {
    const user = await openPicker(MIDNIGHT_TODAY);
    for (let i = 0; i < 12; i++) {
      await user.click(screen.getByRole("button", { name: /next month/i }));
    }
    expect(dayButton("August 15th, 2027")).toBeEnabled();
  });
});

describe("drop-off: minDate is the chosen pick-up", () => {
  // The order form passes `new Date(pickupDate)` as the drop-off minimum,
  // enforcing drop-off >= pick-up. That is a real business rule (the same
  // one `createOrderSchema` refines server-side) and must survive.
  const PICKUP = new Date(2026, 7, 30, 14, 0); // Sun 30 Aug 2026, 14:00

  it("disables the day before the chosen pick-up", async () => {
    await openPicker(PICKUP);
    expect(dayButton("August 29th, 2026")).toBeDisabled();
  });

  it("enables the pick-up day itself", async () => {
    await openPicker(PICKUP);
    expect(dayButton("August 30th, 2026")).toBeEnabled();
  });

  it("enables the last day of the pick-up's month", async () => {
    await openPicker(PICKUP);
    expect(dayButton("August 31st, 2026")).toBeEnabled();
  });

  it("enables the first day of the following month", async () => {
    await openPicker(PICKUP);
    expect(dayButton("September 1st, 2026")).toBeEnabled();
  });

  it("crosses a year boundary too", async () => {
    const user = await openPicker(PICKUP);
    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole("button", { name: /next month/i }));
    }
    expect(dayButton("January 5th, 2027")).toBeEnabled();
  });
});

describe("an outside day must not look like a disabled one", () => {
  /**
   * The reported symptom was visual, and it was a fair report: an enabled
   * outside day and a disabled day rendered at 40% and 30% muted with hover
   * feedback removed from both. Two states that behave completely
   * differently were nearly indistinguishable, so the first days of next
   * month read as unavailable.
   */
  it("keeps hover feedback on a selectable outside day", async () => {
    await openPicker(MIDNIGHT_TODAY);
    const cell = dayButton("September 1st, 2026").closest("td")!;

    expect(dayButton("September 1st, 2026")).toBeEnabled();
    expect(cell.className).toMatch(/hover:bg-accent/);
    expect(cell.className).not.toMatch(/cursor-not-allowed/);
  });

  it("marks a disabled day as not-allowed", async () => {
    await openPicker(MIDNIGHT_TODAY);
    const cell = dayButton("August 26th, 2026").closest("td")!;

    expect(dayButton("August 26th, 2026")).toBeDisabled();
    expect(cell.className).toMatch(/cursor-not-allowed/);
  });

  /**
   * A day can be BOTH outside and disabled — the leading days of the
   * displayed month when they fall before minDate. Here minDate is 1 Sep
   * and the September grid opens with August's last days, which are outside
   * AND unavailable. The disabled styling is scoped to `button:disabled`
   * precisely so it outranks the outside rule instead of the winner being
   * decided by Tailwind's emit order.
   */
  it("still disables a day that is both outside and before minDate", async () => {
    const SEPT_FIRST = new Date(2026, 8, 1, 0, 0, 0, 0);
    await openPicker(SEPT_FIRST);

    const august31 = dayButton("August 31st, 2026");
    expect(august31).toBeDisabled();

    const cell = august31.closest("td")!;
    expect(cell.className).toMatch(/button:disabled\]:cursor-not-allowed/);
  });
});
