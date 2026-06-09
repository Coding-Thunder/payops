 
/**
 * Backfill `orgId` onto child rows that pre-date the multi-tenant
 * hardening pass. For each model, resolves orgId from the parent
 * Order. Idempotent — only touches rows where orgId is missing.
 *
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/backfill-orgid.ts
 *
 * Defaults to a dry-run that prints counts. Pass --apply to write.
 *
 * Targeted collections:
 *   - order_evidence      (parent: orders.orgId via orderId)
 *   - disputes            (parent: orders.orgId via orderId)
 *   - payment_consents    (parent: orders.orgId via orderId)
 *   - pending_emails      (parent: orders.orgId via orderId)
 *   - processed_webhook_events (parent: orders.orgId via orderId,
 *                               when orderId is set; else left null)
 *   - order_drafts        (NOT backfilled — drafts have no Order
 *                          parent; orgId on legacy rows stays null,
 *                          they remain accessible to their owner)
 */
import mongoose, { Types } from "mongoose";

import {
  Dispute,
  Order,
  OrderEvidence,
  PaymentConsent,
} from "@/server/db/models";
import {
  PendingEmail,
  ProcessedWebhookEvent,
} from "@/server/db/models/outbox.model";
import { connectMongo } from "@/server/db/mongoose";

const apply = process.argv.includes("--apply");

interface ChildSpec {
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  /** orderId is required on this collection — backfill walks every
   *  row. When false, the field is nullable so only rows with a
   *  non-null orderId get touched. */
  orderIdRequired: boolean;
}

const TARGETS: ChildSpec[] = [
  { label: "OrderEvidence", model: OrderEvidence, orderIdRequired: true },
  { label: "Dispute", model: Dispute, orderIdRequired: true },
  { label: "PaymentConsent", model: PaymentConsent, orderIdRequired: true },
  { label: "PendingEmail", model: PendingEmail, orderIdRequired: true },
  {
    label: "ProcessedWebhookEvent",
    model: ProcessedWebhookEvent,
    orderIdRequired: false,
  },
];

async function backfillOne(spec: ChildSpec): Promise<{
  scanned: number;
  resolved: number;
  unresolved: number;
}> {
  const filter: Record<string, unknown> = {
    $or: [{ orgId: null }, { orgId: { $exists: false } }],
  };
  if (spec.orderIdRequired) {
    filter.orderId = { $ne: null };
  } else {
    filter.orderId = { $ne: null }; // skip null-orderId rows for safety
  }

  const rows = await spec.model
    .find(filter)
    .select({ _id: 1, orderId: 1 })
    .lean();

  if (rows.length === 0) {
    return { scanned: 0, resolved: 0, unresolved: 0 };
  }

  // Batch the parent-Order lookup.
  const orderIds = Array.from(
    new Set(
      rows.map((r: { orderId: unknown }) => String(r.orderId)),
    ),
  ) as string[];
  const orders = await Order.find({
    _id: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
  })
    .select({ _id: 1, orgId: 1 })
    .lean<{ _id: Types.ObjectId; orgId?: Types.ObjectId | null }[]>();
  const orderOrgIdById = new Map<string, string>();
  for (const o of orders) {
    if (o.orgId) orderOrgIdById.set(String(o._id), String(o.orgId));
  }

  let resolved = 0;
  let unresolved = 0;
  for (const row of rows as { _id: unknown; orderId: unknown }[]) {
    const orgId = orderOrgIdById.get(String(row.orderId));
    if (!orgId) {
      unresolved++;
      continue;
    }
    if (apply) {
      await spec.model.updateOne(
        { _id: row._id },
        { $set: { orgId: new Types.ObjectId(orgId) } },
      );
    }
    resolved++;
  }
  return { scanned: rows.length, resolved, unresolved };
}

async function main(): Promise<void> {
  await connectMongo();
  console.log(
    `${apply ? "APPLY" : "DRY-RUN"} backfill across ${TARGETS.length} collections`,
  );
  console.log("");
  for (const t of TARGETS) {
    const res = await backfillOne(t);
    console.log(
      `  ${t.label.padEnd(24)} scanned=${String(res.scanned).padStart(6)}` +
        `  resolved=${String(res.resolved).padStart(6)}` +
        `  unresolved=${String(res.unresolved).padStart(6)}` +
        `  ${res.unresolved > 0 ? "← orphans (parent Order missing or unscoped)" : ""}`,
    );
  }
  console.log("");
  if (!apply) {
    console.log("Dry-run complete. Re-run with --apply to persist.");
  } else {
    console.log("Backfill applied.");
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
