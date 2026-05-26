/* eslint-disable no-console */
/**
 * Cleanup counterpart to seed-aurora.ts.
 *
 * Removes every record the seed script created — Order, PaymentConsent,
 * Dispute, OrderEvidence (×9), AuditLog rows, PendingEmail rows, and
 * the Mira Holst operator user. Targeted by the deterministic seed
 * orderNumber (`ORD-260805-K4M9P2RT3W`); does NOT delete anything
 * else in the database.
 *
 * Bypasses the OrderEvidence append-only schema hooks via raw
 * `collection.deleteMany` — intentional and the only legitimate use
 * of that bypass.
 *
 * Safety guards mirror the seed:
 *   - Refuses to run against `payops` without `--unsafe-prod`.
 *   - Auto-overrides MONGODB_DB → payops-staging otherwise.
 *
 * Usage:
 *
 *   npm run cleanup:aurora                       # safe default
 *   npx tsx --env-file=.env.prod ... --unsafe-prod   # force prod
 */

import { Types } from "mongoose";

/* ───────────────────── Env override + safety guards ────────────────────── */

const PROD_DB_NAME = "payops";
const DEFAULT_STAGING_DB_NAME = "payops-staging";
const FIXTURE_ORDER_NUMBER = "ORD-260805-K4M9P2RT3W";
// Match both historic and current operator emails so older seeds get
// reliably cleaned up.
const OPERATOR_EMAILS = [
  "mira.holst@example.com",
  "mira.holst@budget-demo.invalid",
  "mira.holst@aurora-cycles.invalid",
];

const args = new Set(process.argv.slice(2));
const allowProd = args.has("--unsafe-prod");
const envDb = process.env.MONGODB_DB;

let targetDb: string;
if (allowProd) {
  targetDb = envDb ?? PROD_DB_NAME;
  if (targetDb === PROD_DB_NAME) {
    console.warn(
      "\n⚠  --unsafe-prod is set. This WILL delete fixture rows from the prod database `payops`.\n",
    );
  }
} else {
  targetDb =
    envDb && envDb !== PROD_DB_NAME ? envDb : DEFAULT_STAGING_DB_NAME;
  if (envDb === PROD_DB_NAME) {
    console.log(
      `  ↪ MONGODB_DB was "${PROD_DB_NAME}" (prod); auto-overriding to "${DEFAULT_STAGING_DB_NAME}" for safety.`,
    );
  }
}

process.env.MONGODB_DB = targetDb;

if (process.env.MONGODB_URI) {
  const rewritten = process.env.MONGODB_URI.replace(
    /\/[^/?]+(\?|$)/,
    `/${targetDb}$1`,
  );
  process.env.MONGODB_URI = rewritten;
}

process.env.PAYOPS_TEST_MODE = "integration";

console.log(`\n› Cleanup target: db=${targetDb}`);

/* ─────────────────────────── Cleanup runner ────────────────────────────── */

async function main() {
  const { connectMongo, disconnectMongo } = await import(
    "../src/server/db/mongoose"
  );
  const { Order } = await import("../src/server/db/models/order.model");
  const { User } = await import("../src/server/db/models/user.model");
  const { PaymentConsent } = await import(
    "../src/server/db/models/payment-consent.model"
  );
  const { Dispute } = await import("../src/server/db/models/dispute.model");
  const { AuditLog } = await import("../src/server/db/models/audit-log.model");
  const { PendingEmail } = await import(
    "../src/server/db/models/outbox.model"
  );
  const { OrderEvidence } = await import(
    "../src/server/db/models/order-evidence.model"
  );

  globalThis.__seedDisconnect = disconnectMongo;

  await connectMongo();

  const order = await Order.findOne({ orderNumber: FIXTURE_ORDER_NUMBER });
  if (!order) {
    console.log(
      `\n✓ No order ${FIXTURE_ORDER_NUMBER} found in db=${targetDb}. Nothing to clean.\n`,
    );
    await disconnectMongo();
    process.exit(0);
  }

  const orderId = order._id;
  const orderIdStr = String(orderId);

  console.log(`\n› Found order ${FIXTURE_ORDER_NUMBER} (${orderId}). Cleaning…`);

  const dispute = await Dispute.findOne({ orderId });
  const disputeIdStr = dispute ? String(dispute._id) : null;

  // OrderEvidence is append-only at the schema level. Bypass via raw
  // collection.deleteMany — intentional and the only legitimate use
  // of that bypass.
  const evidenceResult = await OrderEvidence.collection.deleteMany({
    orderId: new Types.ObjectId(orderIdStr),
  });

  const consentResult = await PaymentConsent.deleteMany({ orderId });
  const disputeResult = await Dispute.deleteMany({ orderId });
  const pendingEmailResult = await PendingEmail.deleteMany({ orderId });

  const auditEntityIds = [orderIdStr];
  if (disputeIdStr) auditEntityIds.push(disputeIdStr);
  const auditResult = await AuditLog.deleteMany({
    entityId: { $in: auditEntityIds },
  });

  const orderResult = await Order.deleteOne({ _id: orderId });

  // Operator user — only delete if no other order references her.
  const otherOrders = await Order.countDocuments({
    "createdBy.email": { $in: OPERATOR_EMAILS },
  });
  let userResult = { deletedCount: 0 };
  if (otherOrders === 0) {
    const res = await User.deleteMany({
      email: { $in: OPERATOR_EMAILS },
    });
    userResult = { deletedCount: res.deletedCount ?? 0 };
  } else {
    console.log(
      `  ⚠ Operator user still has ${otherOrders} other order(s); not deleting the user.`,
    );
  }

  console.log(`
✓ Cleanup complete.

  Database:        ${targetDb}
  Order removed:   ${FIXTURE_ORDER_NUMBER} (${orderResult.deletedCount})
  Consent rows:    ${consentResult.deletedCount}
  Dispute rows:    ${disputeResult.deletedCount}
  Evidence rows:   ${evidenceResult.deletedCount}   (append-only bypass — intentional)
  Audit rows:      ${auditResult.deletedCount}
  Outbox rows:     ${pendingEmailResult.deletedCount}
  Users removed:   ${userResult.deletedCount}
`);

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("\n✖ Cleanup failed:", err);
  try {
    const disconnect = (globalThis as { __seedDisconnect?: () => Promise<void> })
      .__seedDisconnect;
    if (disconnect) await disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

declare global {
  // eslint-disable-next-line no-var
  var __seedDisconnect: (() => Promise<void>) | undefined;
}
