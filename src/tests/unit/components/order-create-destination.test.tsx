import { describe, expect, it, vi, beforeEach } from "vitest";

import { DynamicOrderForm } from "@/components/features/orders/dynamic-order-form";
import { Currency } from "@/lib/constants/enums";
import { ItemPricingModel } from "@/lib/constants/items";
import { RecordState } from "@/lib/constants/enums";
import type { ItemTypeDTO } from "@/server/services/item-type.service";
import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * Where creating an order lands you.
 *
 * It used to push straight to `/app/orders/[id]/email` — step 2 of the
 * payment-request flow. The operator pressed "Create order" and arrived
 * inside a message editor: no confirmation that the order existed, nothing
 * naming what had just been saved, and no obvious way back. The journey audit
 * called it a trap, and it was: the one screen that confirms the creation was
 * the one screen the flow skipped.
 *
 * It now lands on the order itself. The email step is not lost — the detail
 * page carries "Compose payment request" / "Edit payment email" CTAs to the
 * same route — so this is a reordering, not a removal, and the test asserts
 * the destination exactly rather than "contains the id", because
 * `/app/orders/<id>/email` would satisfy a looser match.
 *
 * The other three cases are the ones a redirect change can quietly break:
 * a failed POST must not navigate at all, a double-click must not create two
 * orders, and an empty form must not reach the API.
 */

const push = vi.fn();
const refresh = vi.fn();
const apiPost = vi.fn();
const apiGet = vi.fn();
const toastSuccess = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/app/orders/new",
}));

// Lazy wrappers, not bare references: a vi.mock factory is hoisted above the
// const declarations, so naming them directly hits the temporal dead zone.
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: {
      get: (p: string) => apiGet(p),
      post: (p: string, b: unknown) => apiPost(p, b),
      patch: vi.fn(),
      del: vi.fn(),
    },
  };
});

const ITEM_TYPE: ItemTypeDTO = {
  id: "it_1",
  key: "consulting_hour",
  name: "Consulting hour",
  displayName: "Consulting hour",
  description: null,
  pricingModel: ItemPricingModel.QUANTITY,
  // No scheduling block: this test is about the redirect, not the date fields.
  requiresScheduling: false,
  inventoryTracked: false,
  attributeSchema: [],
  confirmationEmailBlocks: [],
  status: RecordState.ACTIVE,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderForm() {
  return renderWithUser(
    <DynamicOrderForm
      itemTypes={[ITEM_TYPE]}
      defaultCurrency={Currency.USD}
      allowedCurrencies={[Currency.USD]}
    />,
  );
}

/** Adds a line and fills the customer block — the minimum for a valid POST. */
async function fillValidOrder(user: ReturnType<typeof renderForm>["user"]) {
  // "First" adds a line from itemTypes[0] without driving a Radix Select,
  // which jsdom cannot open reliably.
  await user.click(screen.getByRole("button", { name: /first/i }));
  await user.type(screen.getByLabelText("Name", { selector: "#cust-name" }), "Sarah Chen");
  await user.type(screen.getByLabelText("Email"), "sarah@bloomstudio.co");
  await user.type(screen.getByLabelText("Phone"), "+15550100");
}

describe("DynamicOrderForm — post-create destination", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
    apiPost.mockReset();
    apiGet.mockReset();
    toastSuccess.mockReset();
    apiGet.mockResolvedValue({ customer: null });
  });

  it("lands on the order, not the email composer", async () => {
    const { user } = renderForm();
    apiPost.mockResolvedValue({ order: { id: "ord_42" } });

    await fillValidOrder(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][0]).toBe("/api/orders");

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/app/orders/ord_42");
    expect(push).not.toHaveBeenCalledWith("/app/orders/ord_42/email");
    // The detail page is a server component, so the fresh order has to be
    // re-fetched for the new row to appear.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Order created");
  });

  it("stays put and reports the reason when the API refuses", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    const { user } = renderForm();
    apiPost.mockRejectedValue(
      new ApiClientError(422, {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: { issues: [{ path: "customer.email", message: "Invalid email" }] },
      }),
    );

    await fillValidOrder(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // describeApiError drops the envelope's generic "Invalid request data" in
    // favour of the per-field issues, which is the point of it — the operator
    // gets the field, not a shrug.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/please fix the following/i);
    expect(alert).toHaveTextContent(/customer email/i);
    expect(alert).toHaveTextContent(/invalid email/i);
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to the server's message when no fields are named", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    const { user } = renderForm();
    apiPost.mockRejectedValue(
      new ApiClientError(409, {
        code: "CONFLICT",
        message: "That order already exists",
      }),
    );

    await fillValidOrder(user);
    await user.click(screen.getByRole("button", { name: /create order/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /that order already exists/i,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("re-enables submit after a failure so the operator can retry", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    const { user } = renderForm();
    apiPost.mockRejectedValue(
      new ApiClientError(500, { code: "INTERNAL_ERROR", message: "Server error" }),
    );

    await fillValidOrder(user);
    const submit = screen.getByRole("button", { name: /create order/i });
    await user.click(submit);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("does not create two orders on a double-click", async () => {
    const { user } = renderForm();
    let resolve!: (v: unknown) => void;
    apiPost.mockImplementation(
      () => new Promise((r) => {
        resolve = r;
      }),
    );

    await fillValidOrder(user);
    const submit = screen.getByRole("button", { name: /create order/i });
    await user.click(submit);

    // In flight: the button is disabled, so the second click is a no-op.
    await waitFor(() => expect(submit).toBeDisabled());
    await user.click(submit);
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolve({ order: { id: "ord_43" } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/orders/ord_43"));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit an order with no line items", () => {
    renderForm();

    const submit = screen.getByRole("button", { name: /create order/i });
    expect(submit).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
