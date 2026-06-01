import "server-only";

import { Types } from "mongoose";

import { Customer, type CustomerDoc } from "@/server/db/models";
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
