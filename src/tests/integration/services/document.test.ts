import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  Document,
  DocumentKind,
  DocumentSequence,
  Order,
  Organization,
  User,
} from "@/server/db/models";
import {
  getDocumentById,
  getDocumentForRender,
  issueDocument,
  listDocumentsForOrder,
} from "@/server/services/document.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Document service — issue + read + numbering + tenant isolation.
 *
 * Critical invariants asserted:
 *   1. Number allocation is monotonic per (orgId, kind).
 *   2. Two orgs allocate the same INV sequence (orgId scopes it).
 *   3. Issued docs are append-only — re-render reads the snapshot,
 *      not the live order.
 *   4. getDocumentById refuses cross-tenant id-guesses.
 *   5. RECEIPT requires the order to be paid.
 *   6. Rendered HTML contains the tenant's brand + the document
 *      number (smoke test on the renderer).
 */

describe("document.service", () => {
  beforeEach(async () => {
    await ensureMongo();
  });
  afterEach(async () => {
    await resetDatabase();
  });

  async function persistOrgAndOrder(
    label: string,
    opts: { paid?: boolean } = {},
  ): Promise<{
    orgId: string;
    orderId: string;
    actor: {
      id: string;
      name: string;
      email: string;
      role: UserRole;
    };
  }> {
    const ownerId = new Types.ObjectId();
    await User.create({
      _id: ownerId,
      name: `${label} owner`,
      email: `o-${ownerId.toString().slice(-8)}@x.test`,
      passwordHash: "x".repeat(60),
      role: UserRole.SUPER_ADMIN,
      status: RecordState.ACTIVE,
    });
    const org = await Organization.create({
      slug: `t-${ownerId.toString().slice(-8)}`,
      name: `${label} Org`,
      ownerUserId: ownerId,
      status: "ACTIVE",
    });
    const orderId = new Types.ObjectId();
    await Order.create({
      _id: orderId,
      orgId: org._id,
      orderNumber: `${label.toUpperCase()}-${orderId.toString().slice(-4)}`,
      status: opts.paid ? "PAID" : "PAYMENT_PENDING",
      state: RecordState.ACTIVE,
      customer: { name: "Jane Smith", email: "jane@x.test", phone: "+1-555-0000" },
      lineItems: [
        {
          itemTypeKey: "service",
          name: "Consulting hour",
          description: null,
          quantity: 2,
          unitPrice: 150,
          total: 300,
          attributes: {},
        },
      ],
      pricing: { amount: 300, currency: Currency.USD },
      payment: {
        status: opts.paid ? "PAID" : "PAYMENT_PENDING",
        processedWebhookEventIds: [],
        ...(opts.paid
          ? {
              amountReceived: 300,
              paidAt: new Date(),
            }
          : {}),
      },
      createdBy: {
        userId: ownerId,
        name: `${label} owner`,
        email: `o-${ownerId.toString().slice(-8)}@x.test`,
      },
      policy: { acceptedAt: new Date(), version: "v1", text: "" },
      risk: { flagged: false },
      consent: { status: "NOT_REQUESTED" },
    });
    return {
      orgId: String(org._id),
      orderId: String(orderId),
      actor: {
        id: ownerId.toString(),
        name: `${label} owner`,
        email: `o-${ownerId.toString().slice(-8)}@x.test`,
        role: UserRole.SUPER_ADMIN,
      },
    };
  }

  it("issues an INVOICE with a year-prefixed sequential number", async () => {
    const a = await persistOrgAndOrder("alpha");
    const doc = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    expect(doc.number).toMatch(/^INV-\d{4}-0001$/);
    expect(doc.kind).toBe(DocumentKind.INVOICE);
    expect(doc.snapshot.brand.name).toBe("alpha Org");
    expect(doc.snapshot.pricing.grandTotal).toBe(300);
  });

  it("numbering is monotonic per (orgId, kind)", async () => {
    const a = await persistOrgAndOrder("alpha");
    const d1 = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    const d2 = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    expect(d1.number).toMatch(/0001$/);
    expect(d2.number).toMatch(/0002$/);

    const seq = await DocumentSequence.findOne({
      orgId: new Types.ObjectId(a.orgId),
      kind: DocumentKind.INVOICE,
    }).lean<{ lastIssuedSeq: number }>();
    expect(seq?.lastIssuedSeq).toBe(2);
  });

  it("numbering is independent per kind (INVOICE vs RECEIPT)", async () => {
    const a = await persistOrgAndOrder("alpha", { paid: true });
    const inv = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    const rcp = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.RECEIPT },
      { actor: a.actor, orgId: a.orgId },
    );
    expect(inv.number).toMatch(/^INV-\d{4}-0001$/);
    expect(rcp.number).toMatch(/^RCP-\d{4}-0001$/);
  });

  it("two orgs can allocate the same sequence number independently", async () => {
    const a = await persistOrgAndOrder("alpha");
    const b = await persistOrgAndOrder("bravo");
    const da = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    const db = await issueDocument(
      { orderId: b.orderId, kind: DocumentKind.INVOICE },
      { actor: b.actor, orgId: b.orgId },
    );
    expect(da.number).toMatch(/0001$/);
    expect(db.number).toMatch(/0001$/);
    expect(da.orgId).not.toBe(db.orgId);
  });

  it("RECEIPT requires the parent order to be paid", async () => {
    const a = await persistOrgAndOrder("alpha"); // not paid
    await expect(
      issueDocument(
        { orderId: a.orderId, kind: DocumentKind.RECEIPT },
        { actor: a.actor, orgId: a.orgId },
      ),
    ).rejects.toThrow(/hasn't been paid/);
  });

  it("getDocumentById refuses cross-tenant id-guesses", async () => {
    const a = await persistOrgAndOrder("alpha");
    const b = await persistOrgAndOrder("bravo");
    const doc = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    // Tenant B holding A's document id should NOT be able to read it.
    await expect(
      getDocumentById(doc.id, { orgId: b.orgId }),
    ).rejects.toThrow(/not found/i);
  });

  it("listDocumentsForOrder returns docs sorted newest-first", async () => {
    const a = await persistOrgAndOrder("alpha");
    const first = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    // Tiny sleep so issuedAt orders deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const second = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    const list = await listDocumentsForOrder(a.orderId, { orgId: a.orgId });
    expect(list.map((d) => d.id)).toEqual([second.id, first.id]);
  });

  it("documents are append-only — directly trying to update throws", async () => {
    const a = await persistOrgAndOrder("alpha");
    const doc = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    await expect(
      Document.findOneAndUpdate({ _id: doc.id }, { $set: { number: "HAX-1" } }),
    ).rejects.toThrow(/append-only/);
  });

  it("rendered HTML contains the document number and tenant brand", async () => {
    const a = await persistOrgAndOrder("alpha");
    const doc = await issueDocument(
      { orderId: a.orderId, kind: DocumentKind.INVOICE },
      { actor: a.actor, orgId: a.orgId },
    );
    const { html } = await getDocumentForRender(doc.id, { orgId: a.orgId });
    expect(html).toContain(doc.number);
    expect(html).toContain("alpha Org"); // tenant brand
    expect(html).toContain("Jane Smith"); // customer
  });
});
