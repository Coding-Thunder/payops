import "server-only";

import { Types } from "mongoose";

import {
  DEFAULT_CONFIRMATION_BLOCKS,
  EmailBlockKey,
  type SchedulingType,
} from "@/lib/constants/items";
import { ItemType, type ItemTypeDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { OrderDTO } from "@/types";

import { sortBlocks } from "@/server/email/blocks";

/**
 * Pass 5f — Resolve the union of email blocks an order should render.
 *
 * The order's confirmation/request email is composed from the
 * intersection of:
 *
 *   1. `DEFAULT_CONFIRMATION_BLOCKS` — always present (payment summary,
 *      line items table, totals, purchase terms, support section).
 *   2. Per-ItemType `confirmationEmailBlocks` — each line's
 *      `itemTypeKey` resolves against THIS org's ItemType row; its
 *      declared blocks get unioned in.
 *
 * Plus heuristic adjustments that only apply when data is actually
 * present on the order:
 *   - SCHEDULING_WINDOW auto-added when `order.scheduling` exists
 *     (even if no ItemType opted in — the data is there, surface it).
 *   - SIGNATURE_BLOCK callers (request flow) pass it explicitly when
 *     consent has been received.
 *
 * Cross-tenant safety: ItemTypes are looked up by `(orgId, key)` only
 * for the order's owning org. A key collision across orgs cannot leak
 * another tenant's block layout.
 */
export async function resolveEmailBlocksForOrder(
  order: OrderDTO,
  extra: EmailBlockKey[] = [],
): Promise<EmailBlockKey[]> {
  await connectMongo();
  const set = new Set<EmailBlockKey>([
    ...DEFAULT_CONFIRMATION_BLOCKS,
    ...extra,
  ]);

  // Heuristic: scheduling data on the order itself → show the block,
  // regardless of which ItemType signed up for it. Keeps the email
  // honest when an admin forgets to flip the toggle.
  if (order.scheduling) set.add(EmailBlockKey.SCHEDULING_WINDOW);

  // Union per-ItemType blocks.
  if (order.orgId && order.lineItems && order.lineItems.length > 0) {
    const orgObjectId = new Types.ObjectId(order.orgId);
    const keys = Array.from(
      new Set(order.lineItems.map((l) => l.itemTypeKey)),
    );
    if (keys.length > 0) {
      const docs = await ItemType.find({
        orgId: orgObjectId,
        key: { $in: keys },
      })
        .select({ key: 1, confirmationEmailBlocks: 1 })
        .lean<
          Pick<ItemTypeDoc, "key" | "confirmationEmailBlocks">[]
        >();
      for (const t of docs) {
        for (const k of t.confirmationEmailBlocks ?? []) set.add(k);
      }
    }
  }

  return sortBlocks(Array.from(set));
}

// Re-export for convenience so call sites can read the type alongside
// the resolver.
export type { SchedulingType };
