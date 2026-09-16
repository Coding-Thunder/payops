import "server-only";

import ExcelJS from "exceljs";
import type { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  PaymentTiming,
  UserRole,
} from "@/lib/constants/enums";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { summarizeCharges } from "@/lib/charges";
import { ValidationError } from "@/lib/errors";
import type { ListOrdersQuery } from "@/lib/validation";
import { Order, type OrderDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import { buildOrderListFilter } from "./order.service";

/**
 * XLSX export of charging data, one row per CHARGE LINE.
 *
 * Charge grain rather than order grain because the requested columns —
 * charge number, charge amount, due-at-counter state — only exist per line.
 * An order with a prepaid line and a counter line becomes two rows that share
 * an order number.
 *
 * TENANCY AND AUTHORIZATION come from `buildOrderListFilter`, the same
 * function the order list uses. That is deliberate: a hand-written filter
 * here could drift and start emitting rows outside the caller's organization
 * or outside a STAFF user's own orders. The export is exactly the list the
 * caller can already see, in a spreadsheet.
 *
 * MEMORY. Rows stream out of a Mongo cursor with an explicit projection that
 * EXCLUDES the bulk text fields (`terms.text` ≤8000 chars, `policy.text`
 * ≤4000, `notes` ≤2000, `risk.flaggedNote` ≤2000, and the unbounded
 * `payment.processedWebhookEventIds`). Without that projection a few thousand
 * orders is hundreds of MB of strings before a workbook is even built, on a
 * box documented at 512MB–1GB.
 *
 * NOTHING SENSITIVE IS EXPORTED. No card data exists anywhere in this system
 * to leak — the only card-adjacent value ever stored is a manual-payment
 * reference the schema actively prevents from being a PAN. Credentials,
 * tokens and gateway secrets live in the credential vault and are not
 * reachable from the order model.
 */

/** Hard ceiling. Beyond this the operator is asked to narrow the range,
 *  mirroring the evidence export's own cap rather than inventing a policy. */
const EXPORT_MAX_ORDERS = 5_000;

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface ExportActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface ExportContext {
  actor: ExportActor;
  request?: RequestContext | null;
}

/** Only the fields the sheet renders. Everything bulky is left in Mongo. */
const EXPORT_PROJECTION = [
  "orderNumber",
  "bookingType",
  "status",
  "state",
  "customer.name",
  "customer.email",
  "customer.phone",
  "provider.name",
  "vehicle.company",
  "vehicle.type",
  "pricing",
  "charges",
  "confirmationNumber",
  "payment.gateway",
  "payment.status",
  "payment.stripeSessionId",
  "payment.paymentIntentId",
  "payment.paidAt",
  "payment.amountReceived",
  "payment.manualMethod",
  "payment.manualReference",
  "payment.priceRevision",
  "refundedAmount",
  "createdBy.name",
  "createdAt",
  "updatedAt",
].join(" ");

const COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: "Order number", key: "orderNumber", width: 22 },
  { header: "Order status", key: "orderStatus", width: 16 },
  { header: "Booking type", key: "bookingType", width: 18 },
  { header: "Customer name", key: "customerName", width: 22 },
  { header: "Customer email", key: "customerEmail", width: 28 },
  { header: "Customer phone", key: "customerPhone", width: 18 },
  { header: "Provider", key: "provider", width: 16 },
  { header: "Vehicle", key: "vehicle", width: 24 },
  { header: "Charge #", key: "chargeNumber", width: 9 },
  { header: "Charge name", key: "chargeName", width: 24 },
  { header: "Charge amount", key: "chargeAmount", width: 14 },
  { header: "Currency", key: "currency", width: 10 },
  { header: "Due at counter", key: "dueAtCounter", width: 14 },
  { header: "Payment status", key: "paymentStatus", width: 16 },
  { header: "Payment method", key: "paymentMethod", width: 18 },
  { header: "Payment reference", key: "paymentReference", width: 32 },
  { header: "Order prepaid total", key: "prepaidTotal", width: 18 },
  { header: "Amount received", key: "amountReceived", width: 16 },
  { header: "Refunded amount", key: "refundedAmount", width: 16 },
  { header: "Confirmation no.", key: "confirmationNumber", width: 20 },
  { header: "Created by", key: "createdBy", width: 20 },
  { header: "Created at", key: "createdAt", width: 20 },
  { header: "Paid at", key: "paidAt", width: 20 },
  { header: "Updated at", key: "updatedAt", width: 20 },
];

/**
 * The reference an operator can safely see for this payment.
 *
 * A manual payment's reference is the operator's own terminal/auth code —
 * validated on the way in so it cannot be a card number. A gateway payment
 * shows its session id. Neither is card data.
 */
function paymentReferenceOf(payment: OrderDoc["payment"]): string {
  if (payment.manualReference) return payment.manualReference;
  return payment.stripeSessionId ?? payment.paymentIntentId ?? "";
}

/** The label an operator recognises. A manual payment shows the method the
 *  operator typed, not a gateway name that never handled the money. */
function paymentMethodOf(payment: OrderDoc["payment"]): string {
  if (payment.manualMethod) return payment.manualMethod;
  if (!payment.gateway) return "";
  return PaymentGatewayLabel[payment.gateway] ?? payment.gateway;
}

export interface OrderExportResult {
  buffer: Buffer;
  filename: string;
  rowCount: number;
  orderCount: number;
}

export async function buildOrderChargeExport(
  query: ListOrdersQuery,
  ctx: ExportContext,
  /** Stamped into the filename. Injected so the caller owns the clock. */
  now: Date = new Date(),
): Promise<OrderExportResult> {
  await connectMongo();

  // Identical filter to the order list — same tenancy, same STAFF narrowing,
  // same search semantics.
  const scoped = await buildOrderListFilter(query, ctx);

  const orderCount = await Order.countDocuments(scoped);
  if (orderCount > EXPORT_MAX_ORDERS) {
    throw new ValidationError(
      `That range covers ${orderCount.toLocaleString()} orders, which is more than this export can produce at once (${EXPORT_MAX_ORDERS.toLocaleString()}). Narrow the date range and try again.`,
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PayOps";
  workbook.created = now;
  const sheet = workbook.addWorksheet("Charges", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };

  let rowCount = 0;
  const cursor = Order.find(scoped)
    .select(EXPORT_PROJECTION)
    .sort({ createdAt: -1 })
    .lean<OrderDoc & { _id: Types.ObjectId }>()
    .cursor({ batchSize: 200 });

  for await (const doc of cursor) {
    // Legacy orders predate `charges[]`; `summarizeCharges` synthesises the
    // single implicit prepaid line from `pricing.amount` so they export with
    // the same shape rather than as a blank row.
    const summary = summarizeCharges(doc.charges, doc.pricing?.amount ?? 0);
    const lines = summary.charges;
    if (lines.length === 0) continue;

    lines.forEach((line, index) => {
      sheet.addRow({
        orderNumber: doc.orderNumber,
        orderStatus: doc.status,
        bookingType: doc.bookingType,
        customerName: doc.customer?.name ?? "",
        customerEmail: doc.customer?.email ?? "",
        customerPhone: doc.customer?.phone ?? "",
        provider: doc.provider?.name ?? "",
        vehicle: [doc.vehicle?.company, doc.vehicle?.type]
          .filter(Boolean)
          .join(" "),
        // Positional, 1-based. Charge sub-documents are `{_id: false}`, so no
        // stable per-line identifier exists to use instead.
        chargeNumber: index + 1,
        chargeName: line.name,
        // Numeric, not a formatted string, so the column sums in Excel.
        chargeAmount: line.amount,
        currency: doc.pricing?.currency ?? "",
        dueAtCounter: line.timing === PaymentTiming.DUE_AT_COUNTER ? "Yes" : "No",
        paymentStatus: doc.payment?.status ?? "",
        paymentMethod: doc.payment ? paymentMethodOf(doc.payment) : "",
        paymentReference: doc.payment ? paymentReferenceOf(doc.payment) : "",
        prepaidTotal: summary.prepaid,
        amountReceived: doc.payment?.amountReceived ?? null,
        refundedAmount: doc.refundedAmount ?? 0,
        confirmationNumber: doc.confirmationNumber ?? "",
        createdBy: doc.createdBy?.name ?? "",
        // Real Date values so Excel treats them as dates, not text.
        createdAt: doc.createdAt ?? null,
        paidAt: doc.payment?.paidAt ?? null,
        updatedAt: doc.updatedAt ?? null,
      });
      rowCount += 1;
    });
  }

  for (const key of ["chargeAmount", "prepaidTotal", "amountReceived", "refundedAmount"]) {
    sheet.getColumn(key).numFmt = "#,##0.00";
  }
  for (const key of ["createdAt", "paidAt", "updatedAt"]) {
    sheet.getColumn(key).numFmt = "yyyy-mm-dd hh:mm";
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const stamp = now.toISOString().slice(0, 10);

  // A bulk export of customer PII and financial data is exactly the kind of
  // egress every other sensitive route in this codebase records.
  await recordAudit({
    action: AuditAction.ORDER_EXPORTED,
    entityType: AuditEntity.ORDER,
    entityId: "bulk",
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { orderCount, rowCount, query: { ...query } },
  });

  return {
    buffer,
    filename: `payops-charges-${stamp}.xlsx`,
    rowCount,
    orderCount,
  };
}
