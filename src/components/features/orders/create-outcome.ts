import { api, ApiClientError } from "@/lib/api-client";
import type { CreateOrderInput } from "@/lib/validation";
import type { OrderDTO, PaginatedResult } from "@/types";

/**
 * `POST /api/orders` mints a new order on every call. When the request
 * fails in a way that does not say whether the order was written — the
 * connection dropped, the server answered 5xx after inserting, or the reply
 * could not be read — retrying blindly creates a second order for the same
 * booking. These helpers let the create form look before it lets the
 * operator retry.
 */

/**
 * True when a failed create may still have written the order. A 4xx is a
 * refusal made before anything was saved (validation, sign-in, permission,
 * rate limit), so the operator can simply correct and resubmit.
 */
export function isUnknownCreateOutcome(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return true;
  if (err.code === "BAD_RESPONSE") return true;
  return err.status >= 500;
}

/** How far back to look. Generous, so a client clock that disagrees with the
 *  server's does not hide the order that was just written. */
const LOOKBACK_MS = 15 * 60_000;

type Fetcher = (path: string) => Promise<PaginatedResult<OrderDTO>>;

const defaultFetcher: Fetcher = (path) =>
  api.get<PaginatedResult<OrderDTO>>(path);

function sameInstant(a: string, b: string): boolean {
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && x === y;
}

export function matchesSubmittedOrder(
  order: OrderDTO,
  values: CreateOrderInput,
): boolean {
  return (
    order.customer.email.toLowerCase() === values.customer.email.toLowerCase() &&
    order.provider.id === values.provider &&
    sameInstant(order.trip.pickupDate, values.trip.pickupDate) &&
    sameInstant(order.trip.dropoffDate, values.trip.dropoffDate)
  );
}

/**
 * The newest order this operator created recently for the same customer,
 * provider and trip — or null when there is none. Throws when the lookup
 * itself fails, because then the outcome is still unknown.
 */
export async function findJustCreatedOrder(
  values: CreateOrderInput,
  startedAt: number,
  fetcher: Fetcher = defaultFetcher,
): Promise<OrderDTO | null> {
  const params = new URLSearchParams({
    q: values.customer.email,
    mine: "true",
    from: new Date(startedAt - LOOKBACK_MS).toISOString(),
    pageSize: "10",
  });
  const page = await fetcher(`/api/orders?${params.toString()}`);
  return page.items.find((o) => matchesSubmittedOrder(o, values)) ?? null;
}
