import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditAction,
  ConsentStatus,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * REQ-1 — the charging export, asserted by PARSING the workbook.
 *
 * Checking the Content-Type would prove nothing: a corrupt buffer with the
 * right header still "passes". Every test here loads the bytes back through
 * ExcelJS and reads cells, which is the only way to know the file an
 * operator downloads actually opens.
 *
 * Grain is one row per CHARGE LINE, because the requested columns — charge
 * number, charge amount, due-at-counter — only exist per line.
 */

const { createOrder, recordManualPayment } = await import(
  "@/server/services/order.service"
);
const { buildOrderChargeExport } = await import(
  "@/server/services/order-export.service"
);

const admin = actorFor(UserRole.ADMIN);
const staff = actorFor(UserRole.STAFF);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = (actor = admin) => ({ actor, request: null });
const QUERY = { state: RecordState.ACTIVE, page: 1, pageSize: 100 } as never;

/** Load the produced bytes back as a workbook — the real assertion. */
async function parse(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet("Charges")!;
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: Array<Record<string, unknown>> = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const values = (row.values as unknown[]).slice(1);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = values[i];
    });
    rows.push(obj);
  });
  return { wb, sheet, headers, rows };
}

async function makeOrder(charges: Array<{ name: string; amount: number; timing: "PREPAID" | "DUE_AT_COUNTER" }>) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges }),
    ctx(),
  );
  return order;
}

describe("buildOrderChargeExport — a real, parseable workbook", () => {
  it("produces a file ExcelJS can load, with the expected sheet and headers", async () => {
    await makeOrder([{ name: "Rental cost", amount: 500, timing: "PREPAID" }]);
    const result = await buildOrderChargeExport(QUERY, ctx());

    // Real XLSX files are ZIP containers — "PK" is the signature.
    expect(result.buffer.subarray(0, 2).toString("latin1")).toBe("PK");

    const { sheet, headers } = await parse(result.buffer);
    expect(sheet).toBeTruthy();
    expect(headers).toContain("Order number");
    expect(headers).toContain("Charge amount");
    expect(headers).toContain("Due at counter");
    expect(headers).toContain("Payment method");
  });

  it("writes one row per charge line", async () => {
    await makeOrder([
      { name: "Rental cost", amount: 500, timing: "PREPAID" },
      { name: "Fuel option", amount: 40, timing: "DUE_AT_COUNTER" },
      { name: "Extra driver", amount: 25, timing: "DUE_AT_COUNTER" },
    ]);
    const result = await buildOrderChargeExport(QUERY, ctx());
    const { rows } = await parse(result.buffer);

    expect(rows).toHaveLength(3);
    expect(result.rowCount).toBe(3);
    expect(result.orderCount).toBe(1);
    expect(rows.map((r) => r["Charge #"])).toEqual([1, 2, 3]);
  });

  it("keeps amounts NUMERIC so the column sums in Excel", async () => {
    await makeOrder([{ name: "Rental cost", amount: 249.99, timing: "PREPAID" }]);
    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    expect(typeof rows[0]["Charge amount"]).toBe("number");
    expect(rows[0]["Charge amount"]).toBe(249.99);
  });

  it("writes real dates, not strings", async () => {
    await makeOrder([{ name: "Rental cost", amount: 500, timing: "PREPAID" }]);
    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    expect(rows[0]["Created at"]).toBeInstanceOf(Date);
  });

  it("marks the due-at-counter state per line", async () => {
    await makeOrder([
      { name: "Rental cost", amount: 500, timing: "PREPAID" },
      { name: "Fuel option", amount: 40, timing: "DUE_AT_COUNTER" },
    ]);
    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    expect(rows.map((r) => r["Due at counter"])).toEqual(["No", "Yes"]);
  });

  it("handles an empty dataset without producing a broken file", async () => {
    const result = await buildOrderChargeExport(QUERY, ctx());
    expect(result.rowCount).toBe(0);
    const { sheet, headers, rows } = await parse(result.buffer);
    // Headers still present so the operator gets a usable, if empty, sheet.
    expect(sheet).toBeTruthy();
    expect(headers).toContain("Order number");
    expect(rows).toHaveLength(0);
  });

  it("exports multiple orders", async () => {
    await makeOrder([{ name: "Rental cost", amount: 500, timing: "PREPAID" }]);
    await makeOrder([{ name: "Rental cost", amount: 300, timing: "PREPAID" }]);
    const result = await buildOrderChargeExport(QUERY, ctx());
    const { rows } = await parse(result.buffer);
    expect(rows).toHaveLength(2);
    expect(result.orderCount).toBe(2);
  });
});

describe("buildOrderChargeExport — values", () => {
  it("carries the customer and payment columns through correctly", async () => {
    const order = await makeOrder([
      { name: "Rental cost", amount: 500, timing: "PREPAID" },
    ]);
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.status": OrderStatus.PAID,
          "payment.stripeSessionId": "cs_abc",
          "payment.amountReceived": 500,
          "payment.paidAt": new Date(),
          status: OrderStatus.PAID,
        },
      },
    );

    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    const row = rows[0];
    expect(row["Order number"]).toBe(order.orderNumber);
    expect(row["Customer name"]).toBe("Ada Lovelace");
    expect(row["Customer email"]).toBe("ada@payops.test");
    expect(row["Payment method"]).toBe("Stripe");
    expect(row["Payment reference"]).toBe("cs_abc");
    expect(row["Amount received"]).toBe(500);
    expect(row["Order status"]).toBe(OrderStatus.PAID);
  });

  it("shows the operator's own method for a manual payment, not a gateway name", async () => {
    const order = await makeOrder([
      { name: "Rental cost", amount: 500, timing: "PREPAID" },
    ]);
    await Order.updateOne(
      { _id: order.id },
      { $set: { "consent.status": ConsentStatus.RECEIVED } },
    );
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-004521" },
      ctx(),
    );

    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    expect(rows[0]["Payment method"]).toBe("Card terminal");
    expect(rows[0]["Payment reference"]).toBe("AUTH-004521");
  });

  it("exports nothing that looks like card data", async () => {
    const order = await makeOrder([
      { name: "Rental cost", amount: 500, timing: "PREPAID" },
    ]);
    await Order.updateOne(
      { _id: order.id },
      { $set: { "consent.status": ConsentStatus.RECEIVED } },
    );
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-004521" },
      ctx(),
    );

    const { rows } = await parse(
      (await buildOrderChargeExport(QUERY, ctx())).buffer,
    );
    const blob = JSON.stringify(rows);
    // No PAN-length digit run anywhere in the sheet.
    expect(/\b\d{13,19}\b/.test(blob)).toBe(false);
    // And no secret-ish column leaked in.
    expect(blob).not.toMatch(/sk_live|sk_test|whsec_|client_secret/i);
  });
});

describe("buildOrderChargeExport — authorization and tenancy", () => {
  it("narrows a STAFF export to their own orders", async () => {
    // The whole reason the export reuses `buildOrderListFilter`: this
    // narrowing is not re-implemented here and so cannot drift from the list.
    await makeOrder([{ name: "Admin order", amount: 500, timing: "PREPAID" }]);

    const result = await buildOrderChargeExport(QUERY, ctx(staff));
    const { rows } = await parse(result.buffer);
    // The admin's order is not the staff user's, so it must not appear.
    expect(rows).toHaveLength(0);
  });

  it("honours the search filter exactly as the list does", async () => {
    const a = await makeOrder([{ name: "Rental cost", amount: 500, timing: "PREPAID" }]);
    await makeOrder([{ name: "Rental cost", amount: 300, timing: "PREPAID" }]);

    const { rows } = await parse(
      (
        await buildOrderChargeExport(
          { ...(QUERY as object), q: a.orderNumber } as never,
          ctx(),
        )
      ).buffer,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]["Order number"]).toBe(a.orderNumber);
  });

  it("records an audit row for the bulk egress", async () => {
    await makeOrder([{ name: "Rental cost", amount: 500, timing: "PREPAID" }]);
    await buildOrderChargeExport(QUERY, ctx());

    const rows = await AuditLog.find({
      action: AuditAction.ORDER_EXPORTED,
    }).lean<Array<{ actor: { userId: string }; metadata: Record<string, unknown> }>>();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].actor.userId)).toBe(admin.id);
    expect(rows[0].metadata.rowCount).toBe(1);
  });
});
