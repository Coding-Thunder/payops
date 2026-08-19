import { notFound } from "next/navigation";

/**
 * Catch-all for unmatched console URLs.
 *
 * Without it, a typo'd `/admin/does-not-exsit` matches no segment under
 * `src/app/admin/`, so Next falls all the way back to the ROOT
 * `src/app/not-found.tsx` — which renders the tenant-branded 404 with a
 * "Back home" link to `/`, outside the console's layout and palette. That is
 * boundary leakage: the operator is handed the customer-facing app.
 *
 * Matching here keeps the request inside `src/app/admin/layout.tsx`, so
 * `notFound()` resolves to the console's own `not-found.tsx`.
 *
 * Next resolves static and dynamic segments before a catch-all, so this
 * cannot shadow `/admin/orders/[id]` or any other real console route.
 */
export default function UnmatchedConsoleRoute(): never {
  notFound();
}
