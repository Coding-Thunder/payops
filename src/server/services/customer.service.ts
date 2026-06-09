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
  ordersCount: number;
  lastOrderAt: string | null;
}

function toDTO(doc: CustomerDoc & { _id: Types.ObjectId }): CustomerDTO {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    ordersCount: doc.ordersCount,
    lastOrderAt: doc.lastOrderAt ? doc.lastOrderAt.toISOString() : null,
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
  const update: Record<string, unknown> = {
    $set: {
      name: input.name.trim(),
      phone: input.phone.trim(),
    },
    $setOnInsert: { email, orgId: orgIdFilter(scopedOrgId) },
  };
  if (options.countAsOrder) {
    (update.$inc as Record<string, number>) = { ordersCount: 1 };
    (update.$set as Record<string, unknown>).lastOrderAt = now;
  }
  await Customer.updateOne(
    { orgId: orgIdFilter(scopedOrgId), email },
    update,
    { upsert: true },
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
