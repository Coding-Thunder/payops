import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Types } from "mongoose";

import {
  AuditAction,
  PaymentGatewayKey,
  ServiceType,
} from "@/lib/constants/enums";
import { BadRequestError } from "@/lib/errors";
import { AuditLog, Order, Organization } from "@/server/db/models";
import { withOrganizationScope } from "@/server/db/organization-filter";
import {
  getPublicAcknowledgementView,
  recordTermsAcknowledgement,
} from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { ensureMongo } from "@/tests/utils/db";
import {
  createPaidOrder,
  itineraryFlight,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("terms acknowledgement flow", () => {
  it("records the customer's acknowledgement from a signed token (no auth)", async () => {
    const order = await createPaidOrder({});
    const token = generateAckToken(String(order._id));

    const before = await getPublicAcknowledgementView(token);
    expect(before.acknowledgedAt).toBeNull();

    const after = await recordTermsAcknowledgement(token, { request: null });
    expect(after.acknowledgedAt).toBeTruthy();

    const stored = await Order.findById(order._id).lean();
    expect(stored?.termsAcknowledgement?.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("is idempotent on duplicate clicks — does not re-stamp", async () => {
    const order = await createPaidOrder({});
    const token = generateAckToken(String(order._id));

    const first = await recordTermsAcknowledgement(token, { request: null });
    const second = await recordTermsAcknowledgement(token, { request: null });
    // Same timestamp — the second click returns the existing record.
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it("rejects an invalid / malformed token", async () => {
    await expect(
      getPublicAcknowledgementView("not-a-real-token"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("a token can only acknowledge its own booking", async () => {
    const a = await createPaidOrder({});
    const b = await createPaidOrder({});
    const tokenA = generateAckToken(String(a._id));

    await recordTermsAcknowledgement(tokenA, { request: null });

    const storedA = await Order.findById(a._id).lean();
    const storedB = await Order.findById(b._id).lean();
    expect(storedA?.termsAcknowledgement?.acknowledgedAt).toBeInstanceOf(Date);
    // Order B is untouched — the token is bound to A's id.
    expect(storedB?.termsAcknowledgement ?? null).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The acknowledgement's audit rows belong to the ORDER's organization
 *
 * The /acknowledge page is public: no session, no organization cookie, so
 * the ambient scope stamps nothing — and an unattributed audit row is
 * visible only to the default organization. A brand whose customer accepted
 * its terms could not see that it happened. Every row now carries the
 * order's own organization; the default organization sees exactly what it
 * always saw.
 * ------------------------------------------------------------------ */

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/** Hand the ops notification a transport that records what it was asked to
 *  send — or fails, to drive the EMAIL_FAILED row. */
async function captureOpsMail(fail = false): Promise<SentMail[]> {
  const smtp = await import("@/server/email/smtp");
  const sent: SentMail[] = [];
  vi.spyOn(smtp, "getMailer").mockReturnValue({
    sendMail: async (mail: SentMail) => {
      if (fail) throw new Error("SMTP down");
      sent.push(mail);
      return { messageId: "<ack-ops@test>" };
    },
  } as never);
  return sent;
}

async function brandOrg(slug: string, isDefault = false): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.PAYPAL },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
    email: { fromName: `${slug} brand`, fromEmail: `bookings@${slug}.test` },
  });
  return doc._id as Types.ObjectId;
}

interface AuditRow {
  action: string;
  organizationId?: Types.ObjectId | null;
  metadata?: { action?: string; kind?: string };
}

async function ackAudits(orderId: Types.ObjectId) {
  const rows = await AuditLog.find({ entityId: String(orderId) }).lean<AuditRow[]>();
  return {
    acknowledged: rows.filter((r) => r.metadata?.action === "terms_acknowledged"),
    ops: rows.filter((r) => r.metadata?.kind === "TERMS_ACKNOWLEDGED_OPS"),
  };
}

describe("acknowledgement audit rows are stamped with the order's organization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps a non-default brand's acknowledgement and its ops notification with that brand", async () => {
    const brand = await brandOrg("tripbrand");
    const order = await createPaidOrder({ organizationId: brand });
    const mail = await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    const { acknowledged, ops } = await ackAudits(order._id);
    expect(acknowledged).toHaveLength(1);
    expect(String(acknowledged[0]!.organizationId)).toBe(String(brand));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe(AuditAction.EMAIL_SENT);
    expect(String(ops[0]!.organizationId)).toBe(String(brand));
    expect(mail).toHaveLength(1);

    // Visible in the brand's own audit trail.
    const visible = await AuditLog.countDocuments(
      withOrganizationScope(
        { entityId: String(order._id) },
        { organizationId: String(brand), isDefault: false },
      ),
    );
    expect(visible).toBe(2);
  });

  it("stamps the EMAIL_FAILED row too when the ops notification cannot be sent", async () => {
    const brand = await brandOrg("tripbrand");
    const order = await createPaidOrder({ organizationId: brand });
    await captureOpsMail(true);

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    const { ops } = await ackAudits(order._id);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe(AuditAction.EMAIL_FAILED);
    expect(String(ops[0]!.organizationId)).toBe(String(brand));
  });

  it("leaves an order with no organization (a pre-migration row) unattributed, as before", async () => {
    await brandOrg("defaultbrand", true);
    const order = await createPaidOrder({});
    await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    const { acknowledged, ops } = await ackAudits(order._id);
    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0]!.organizationId ?? null).toBeNull();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.organizationId ?? null).toBeNull();
  });

  it("keeps the default organization's rows in the default organization's view — and out of any other's", async () => {
    const defaultOrg = await brandOrg("defaultbrand", true);
    const other = await brandOrg("tripbrand");
    const order = await createPaidOrder({ organizationId: defaultOrg });
    await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    const filter = { entityId: String(order._id) };
    const asDefault = await AuditLog.countDocuments(
      withOrganizationScope(filter, { organizationId: String(defaultOrg), isDefault: true }),
    );
    const asOther = await AuditLog.countDocuments(
      withOrganizationScope(filter, { organizationId: String(other), isDefault: false }),
    );
    expect(asDefault).toBe(2);
    expect(asOther).toBe(0);
  });
});

describe("the ops notification names the order's one booking reference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries a flight's PNR still kept in flight.pnr", async () => {
    const brand = await brandOrg("tripbrand");
    const order = await createPaidOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: brand,
      flight: itineraryFlight({ pnr: "QX7T2L" }),
      confirmationNumber: null,
    });
    const mail = await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("Confirmation# : QX7T2L");
  });

  it("carries a car rental's confirmation number exactly as before", async () => {
    const order = await createPaidOrder({ confirmationNumber: "SUPP-9F3K2218" });
    const mail = await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    expect(mail[0]!.text).toContain("Confirmation# : SUPP-9F3K2218");
  });

  it("prints a dash when there is no reference yet", async () => {
    const order = await createPaidOrder({});
    const mail = await captureOpsMail();

    await recordTermsAcknowledgement(generateAckToken(String(order._id)), { request: null });

    expect(mail[0]!.text).toContain("Confirmation# : —");
  });
});
