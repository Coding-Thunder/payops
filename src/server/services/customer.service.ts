import "server-only";

import { Types } from "mongoose";

import { RecordState } from "@/lib/constants/enums";
import { NotFoundError } from "@/lib/errors";
import {
  Customer,
  Order,
  type CustomerDoc,
  type OrderDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

/**
 * Pass 6d, saved customer records.
 *
 * Two callers only:
 *  - `upsertCustomerFromOrder` fires after every successful order
 *    create + every customer-detail patch. Best-effort: the order is
 *    the source of truth, and a failed upsert here must never block
 *    the order workflow.
 *  - `findCustomerByEmail` powers the order-form email-blur prefill.
 *
 * Deliberately no admin CRUD, no list page, no soft-delete. This
 * collection only exists to keep operators from re-typing the same
 * customer's details on every order.
 */

export interface CustomerDTO {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  notes: string | null;
  tags: string[];
  ordersCount: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  customerSince: string | null;
}

function toDTO(doc: CustomerDoc & { _id: Types.ObjectId }): CustomerDTO {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    company: doc.company ?? null,
    notes: doc.notes ?? null,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    ordersCount: doc.ordersCount,
    firstOrderAt: doc.firstOrderAt ? doc.firstOrderAt.toISOString() : null,
    lastOrderAt: doc.lastOrderAt ? doc.lastOrderAt.toISOString() : null,
    customerSince: doc.createdAt ? doc.createdAt.toISOString() : null,
  };
}

export interface UpsertCustomerInput {
  name: string;
  email: string;
  phone: string;
}

/**
 * Idempotent upsert by (orgId, lower-cased email). Latest-write-wins
 * on name + phone, the operator's most recent typing is treated as
 * the freshest signal. `ordersCount` increments only when called from
 * the create-order path (`countAsOrder: true`).
 */
export async function upsertCustomerFromOrder(
  orgId: string | null | undefined,
  input: UpsertCustomerInput,
  options: { countAsOrder?: boolean } = {},
): Promise<void> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const email = input.email.toLowerCase().trim();
  if (!email) return;
  const now = new Date();
  const setOnInsert: Record<string, unknown> = {
    email,
    orgId: orgIdFilter(scopedOrgId),
  };
  const update: Record<string, unknown> = {
    $set: {
      name: input.name.trim(),
      phone: input.phone.trim(),
    },
    $setOnInsert: setOnInsert,
  };
  if (options.countAsOrder) {
    (update.$inc as Record<string, number>) = { ordersCount: 1 };
    (update.$set as Record<string, unknown>).lastOrderAt = now;
    // First contact stamp — only lands on insert, so it captures the
    // earliest order and never moves.
    setOnInsert.firstOrderAt = now;
  }
  await Customer.updateOne(
    { orgId: orgIdFilter(scopedOrgId), email },
    update,
    { upsert: true },
  );
}

/**
 * Resolve the Client Profile an order belongs to, creating one if this
 * is a net-new client. Linking precedence mirrors the product spec:
 *
 *   1. exact email match  → attach to that profile
 *   2. exact phone match  → attach (email is new, but we've seen the
 *                            phone before — same human, new address)
 *   3. otherwise          → create a fresh profile
 *
 * Concurrency-safe: two orders racing to create the same email collide
 * on the `(orgId, email)` unique index; the loser re-reads the winner's
 * row. Returns the customer id, or `null` when there's nothing to key on
 * (neither email nor phone) so the caller can leave the order unlinked.
 *
 * Does NOT touch counters — call {@link bumpCustomerOrderAggregates}
 * after the order commits for that. Kept separate so the id can be
 * resolved *before* the order transaction and stamped onto the order.
 */
export async function resolveOrCreateCustomer(
  orgId: string | null | undefined,
  input: UpsertCustomerInput,
): Promise<string | null> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const email = input.email.toLowerCase().trim();
  const phone = input.phone.trim();
  const name = input.name.trim();
  const filterOrg = orgIdFilter(scopedOrgId);

  if (email) {
    const byEmail = await Customer.findOne({ orgId: filterOrg, email })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId } | null>();
    if (byEmail) return String(byEmail._id);
  }

  if (phone) {
    const byPhone = await Customer.findOne({ orgId: filterOrg, phone })
      .sort({ createdAt: 1 })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId } | null>();
    if (byPhone) return String(byPhone._id);
  }

  if (!email && !phone) return null;

  try {
    const created = await Customer.create({
      orgId: filterOrg,
      name,
      email,
      phone,
      tags: [],
    });
    return String(created._id);
  } catch (err) {
    // Lost a create race on the unique (orgId, email) index — the
    // winner's row now exists, so re-read it.
    if (isDuplicateKeyError(err) && email) {
      const again = await Customer.findOne({ orgId: filterOrg, email })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId } | null>();
      if (again) return String(again._id);
    }
    throw err;
  }
}

/**
 * Roll a freshly-created order into its Client Profile's cheap counters
 * (orders count, first/last activity) and refresh the latest-typed
 * name/phone. Financial totals are never denormalised here — the
 * profile recomputes those from the linked orders on read.
 *
 * Best-effort by contract: the caller wraps this so a counter write can
 * never fail an order. Idempotency isn't guaranteed (the `$inc`), but the
 * backfill migration rebuilds every counter authoritatively, so drift is
 * self-healing.
 */
export async function bumpCustomerOrderAggregates(
  orgId: string | null | undefined,
  customerId: string,
  input: { name: string; phone: string; orderCreatedAt: Date },
): Promise<void> {
  const scopedOrgId = requireOrgId(orgId);
  if (!Types.ObjectId.isValid(customerId)) return;
  await connectMongo();
  await Customer.updateOne(
    { _id: new Types.ObjectId(customerId), orgId: orgIdFilter(scopedOrgId) },
    {
      $set: { name: input.name.trim(), phone: input.phone.trim() },
      $inc: { ordersCount: 1 },
      $min: { firstOrderAt: input.orderCreatedAt },
      $max: { lastOrderAt: input.orderCreatedAt },
    },
  );
}

/** Narrow a thrown Mongo error to the duplicate-key case (E11000). */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}

/** Email lookup, returns the saved record or null. Powers the order
 *  form's "we know this customer" prefill. Case-insensitive (the
 *  model lower-cases on write). */
export async function findCustomerByEmail(
  orgId: string | null | undefined,
  email: string,
): Promise<CustomerDTO | null> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const normalised = email.toLowerCase().trim();
  if (!normalised) return null;
  const doc = await Customer.findOne({
    orgId: orgIdFilter(scopedOrgId),
    email: normalised,
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  return doc ? toDTO(doc) : null;
}

/* ─── Customer detail surface ──────────────────────────────────────────── */

/**
 * Look up a saved customer by its Mongo id. Cross-tenant guard:
 * filter pins both `_id` AND `orgId` so an admin of org A holding
 * a guessed id from org B gets a clean 404, not the wrong row.
 */
export async function getCustomerById(
  orgId: string | null | undefined,
  customerId: string,
): Promise<CustomerDTO> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Customer not found");
  }
  const doc = await Customer.findOne({
    _id: new Types.ObjectId(customerId),
    orgId: orgIdFilter(scopedOrgId),
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Customer not found");
  return toDTO(doc);
}

export interface CustomerOrderRowDTO {
  id: string;
  orderNumber: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  paidAt: string | null;
}

/**
 * Recent orders associated with a saved customer, looked up by
 * (orgId, customer.email). Joining on email rather than a
 * customerId field on Order means historical orders predating the
 * customer record still surface — operator-friendly.
 *
 * Capped at 50 by default; the customer detail page renders a
 * paginated table if a tenant needs deeper history.
 */
export async function listOrdersForCustomer(
  orgId: string | null | undefined,
  email: string,
  limit = 50,
): Promise<CustomerOrderRowDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const normalised = email.toLowerCase().trim();
  if (!normalised) return [];
  const docs = await Order.find({
    orgId: orgIdFilter(scopedOrgId),
    state: { $ne: RecordState.ARCHIVED },
    "customer.email": normalised,
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .lean<(OrderDoc & { _id: Types.ObjectId })[]>();
  return docs.map((d) => ({
    id: String(d._id),
    orderNumber: d.orderNumber,
    status: d.status,
    amount: d.pricing.amount,
    currency: d.pricing.currency,
    createdAt: d.createdAt.toISOString(),
    paidAt: d.payment?.paidAt ? d.payment.paidAt.toISOString() : null,
  }));
}
