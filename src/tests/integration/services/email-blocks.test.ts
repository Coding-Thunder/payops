import { render } from "@react-email/render";
import { Types } from "mongoose";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Currency, OrderStatus, RecordState } from "@/lib/constants/enums";
import {
  EmailBlockKey,
  ItemAttributeType,
  ItemPricingModel,
  SchedulingType,
} from "@/lib/constants/items";
import { ItemType } from "@/server/db/models";
import { resolveEmailBlocksForOrder } from "@/server/services/email-blocks.service";
import {
  BLOCK_ORDER,
  sortBlocks,
} from "@/server/email/blocks";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
import type { OrderDTO } from "@/types";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

afterEach(async () => {
  // nothing per-test
});

function baseOrder(over: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: "order-1",
    orgId: over.orgId ?? null,
    orderNumber: "ORD-PREVIEW-1",
    status: OrderStatus.PAID,
    state: RecordState.ACTIVE,
    customer: { name: "Jane", email: "jane@example.com", phone: "+1" },
    pricing: { amount: 100, currency: Currency.USD },
    payment: {
      gateway: null,
      paymentSessionId: null,
      paymentUrl: null,
      paymentIntentId: null,
      status: OrderStatus.PAID,
      paidAt: new Date().toISOString(),
      expiresAt: null,
      amountReceived: 100,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: null,
    },
    createdBy: { userId: "u", name: "u", email: "u@x" },
    policy: {
      acceptedAt: new Date().toISOString(),
      version: "v1",
      text: "Sample policy.",
    },
    risk: { flagged: false },
    consent: { status: "NOT_REQUESTED" } as OrderDTO["consent"],
    dispute: null,
    refundedAmount: 0,
    notes: null,
    lineItems: [
      {
        itemId: null,
        itemTypeKey: "milk_carton",
        name: "1L milk",
        description: null,
        quantity: 2,
        unitPrice: 4,
        total: 8,
        attributes: { fat_percent: 3.5 },
        scheduling: null,
      },
    ],
    scheduling: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as OrderDTO;
}

describe("sortBlocks", () => {
  it("preserves the canonical BLOCK_ORDER + dedupes input", () => {
    const sorted = sortBlocks([
      EmailBlockKey.SUPPORT_SECTION,
      EmailBlockKey.PAYMENT_SUMMARY,
      EmailBlockKey.TOTALS,
      EmailBlockKey.PAYMENT_SUMMARY, // dupe
      EmailBlockKey.LINE_ITEMS_TABLE,
    ]);
    expect(sorted).toEqual([
      EmailBlockKey.PAYMENT_SUMMARY,
      EmailBlockKey.LINE_ITEMS_TABLE,
      EmailBlockKey.TOTALS,
      EmailBlockKey.SUPPORT_SECTION,
    ]);
  });

  it("BLOCK_ORDER mentions every EmailBlockKey value", () => {
    const all = Object.values(EmailBlockKey);
    expect(new Set(BLOCK_ORDER)).toEqual(new Set(all));
  });
});

describe("resolveEmailBlocksForOrder", () => {
  it("returns DEFAULT_CONFIRMATION_BLOCKS for an order whose ItemType has no extras", async () => {
    const orgId = new Types.ObjectId();
    await ItemType.create({
      orgId,
      key: "milk_carton",
      name: "Milk",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "fat_percent",
          label: "Fat %",
          type: ItemAttributeType.NUMBER,
          required: false,
          displayOrder: 0,
        },
      ],
      confirmationEmailBlocks: [],
    });
    const order = baseOrder({ orgId: orgId.toString() });
    const blocks = await resolveEmailBlocksForOrder(order);
    expect(blocks).toEqual([
      EmailBlockKey.PAYMENT_SUMMARY,
      EmailBlockKey.LINE_ITEMS_TABLE,
      EmailBlockKey.TOTALS,
      EmailBlockKey.PURCHASE_TERMS,
      EmailBlockKey.SUPPORT_SECTION,
    ]);
  });

  it("unions ItemType.confirmationEmailBlocks into the resolved set", async () => {
    const orgId = new Types.ObjectId();
    await ItemType.create({
      orgId,
      key: "rental_booking",
      name: "Rental",
      pricingModel: ItemPricingModel.TIME_WINDOW,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [
        EmailBlockKey.SCHEDULING_WINDOW,
        EmailBlockKey.ITEM_HERO,
      ],
    });
    const order = baseOrder({
      orgId: orgId.toString(),
      lineItems: [
        {
          itemId: null,
          itemTypeKey: "rental_booking",
          name: "Rental",
          description: null,
          quantity: 1,
          unitPrice: 100,
          total: 100,
          attributes: { vehicle_image_url: "https://example.com/hero.jpg" },
          scheduling: null,
        },
      ],
    });
    const blocks = await resolveEmailBlocksForOrder(order);
    expect(blocks).toContain(EmailBlockKey.SCHEDULING_WINDOW);
    expect(blocks).toContain(EmailBlockKey.ITEM_HERO);
    expect(blocks).toContain(EmailBlockKey.LINE_ITEMS_TABLE);
  });

  it("auto-adds SCHEDULING_WINDOW when order.scheduling exists even if no ItemType opted in", async () => {
    const orgId = new Types.ObjectId();
    await ItemType.create({
      orgId,
      key: "service_visit",
      name: "Service visit",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    });
    const order = baseOrder({
      orgId: orgId.toString(),
      lineItems: [
        {
          itemId: null,
          itemTypeKey: "service_visit",
          name: "Service visit",
          description: null,
          quantity: 1,
          unitPrice: 100,
          total: 100,
          attributes: {},
          scheduling: null,
        },
      ],
      scheduling: {
        type: SchedulingType.FIXED_WINDOW,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const blocks = await resolveEmailBlocksForOrder(order);
    expect(blocks).toContain(EmailBlockKey.SCHEDULING_WINDOW);
  });

  it("REFUSES cross-tenant ItemType reuse — Org B's order ignores Org A's blocks", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    await ItemType.create({
      orgId: orgA,
      key: "milk_carton",
      name: "A's milk",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [EmailBlockKey.PRESCRIPTION_BLOCK],
    });
    const order = baseOrder({ orgId: orgB.toString() });
    const blocks = await resolveEmailBlocksForOrder(order);
    // Org B has NO milk_carton row, so the cross-tenant `PRESCRIPTION_BLOCK`
    // contribution should not leak into the resolution.
    expect(blocks).not.toContain(EmailBlockKey.PRESCRIPTION_BLOCK);
  });
});

describe("UniversalOrderEmail render", () => {
  it("renders without throwing for a universal-shape order (no rental fields)", async () => {
    const order = baseOrder();
    const html = await render(
      React.createElement(UniversalOrderEmail, {
        variant: "confirmation",
        blocks: sortBlocks([
          EmailBlockKey.PAYMENT_SUMMARY,
          EmailBlockKey.LINE_ITEMS_TABLE,
          EmailBlockKey.TOTALS,
          EmailBlockKey.PURCHASE_TERMS,
          EmailBlockKey.SUPPORT_SECTION,
        ]),
        ctx: {
          order,
          branding: {
            brandName: "PayOps",
            supportEmail: "support@payops.test",
            supportPhone: "+1 555 0000",
          },
          payment: {
            amount: "$8.00",
            paidOn: "May 17, 2026",
            receiptUrl: null,
          },
        },
      }),
    );
    expect(html).toContain("ORD-PREVIEW-1");
    expect(html).toContain("1L milk");
    expect(html).toContain("Payment confirmed");
  });

  it("request variant renders the CTA button + greeting + intro", async () => {
    const order = baseOrder();
    const html = await render(
      React.createElement(UniversalOrderEmail, {
        variant: "request",
        blocks: sortBlocks([
          EmailBlockKey.LINE_ITEMS_TABLE,
          EmailBlockKey.TOTALS,
          EmailBlockKey.SUPPORT_SECTION,
        ]),
        ctx: {
          order,
          branding: {
            brandName: "PayOps",
            supportEmail: "support@payops.test",
            supportPhone: "+1 555 0000",
          },
          payment: null,
        },
        cta: {
          url: "https://example.com/consent/abc",
          label: "Agree & Continue to Payment",
          helperText: "I agree to proceed.",
        },
        greeting: "Hi Jane,",
        intro: "Custom intro paragraph.",
        note: null,
      }),
    );
    expect(html).toContain("Hi Jane,");
    expect(html).toContain("Custom intro paragraph.");
    expect(html).toContain("Agree &amp; Continue to Payment");
    expect(html).toContain("https://example.com/consent/abc");
  });
});
