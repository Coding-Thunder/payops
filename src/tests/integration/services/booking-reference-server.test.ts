import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { CONNECTION_CHRONOLOGY_MESSAGE } from "@/lib/flight-itinerary";
import type { ListOrdersQuery } from "@/lib/validation";
import {
  AuditLog,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  Provider,
} from "@/server/db/models";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { orgCookieName } from "@/server/auth/org-cookie";
import {
  createOrder,
  getOrderById,
  listOrders,
  resendConfirmationEmail,
  setConfirmationNumber,
} from "@/server/services/order.service";
import {
  createProvider,
  invalidateProviderLogoCache,
} from "@/server/services/provider.service";
import {
  buildOrder,
  createOrder as factoryCreateOrder,
  itineraryFlight,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  flightJourneyInput,
  flightSegmentInput,
  FLIGHT_SEGMENTS,
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";

/**
 * ONE booking reference per order, on the server.
 *
 * The supplier's reference — the airline's PNR, the hotel's confirmation
 * number, the rental company's confirmation number — lives in ONE place:
 * `order.confirmationNumber`. A flight's create form takes its PNR, and it
 * is stored there, never in a second copy under `flight`. A flight created
 * before this kept its PNR in `flight.pnr`; it reads as the order's
 * reference (`bookingReference`) until an operator saves a new one, which
 * moves it into `confirmationNumber` and clears the old copy — without ever
 * re-validating an itinerary that was valid when it was placed.
 *
 * Every assertion is service-generic: nothing here is specific to one
 * organization, and the car rental's behaviour is pinned unchanged.
 */

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
/** A brand that sells all three services — the TripReservations shape,
 *  but nothing below depends on which brand it is. */
let brand: Types.ObjectId;

async function makeOrg(slug: string): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
    // A non-default brand sends customer email only from its own sender.
    email: { fromName: `${slug} brand`, fromEmail: `bookings@${slug}.test` },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  brand = await makeOrg("multibrand");
  actingAs(brand);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

interface StoredOrder {
  confirmationNumber?: string | null;
  flight?: { pnr?: string | null; outbound?: { segments: { departure: { time: string } }[] } } | null;
  updatedAt: Date;
}

async function stored(orderId: string | Types.ObjectId): Promise<StoredOrder> {
  const doc = await Order.findById(orderId).lean<StoredOrder | null>();
  expect(doc, "order not stored").toBeTruthy();
  return doc!;
}

async function genesisPayload(orderId: string): Promise<Record<string, unknown>> {
  const row = await OrderEvidence.findOne({
    orderId: new Types.ObjectId(orderId),
    eventType: OrderEvidenceEventType.ORDER_CREATED,
  }).lean<{ payload: Record<string, unknown> } | null>();
  expect(row, "no genesis evidence row").toBeTruthy();
  return row!.payload;
}

async function referenceAudits(orderId: string | Types.ObjectId) {
  return AuditLog.find({
    action: AuditAction.ORDER_UPDATED,
    entityId: String(orderId),
    "metadata.action": "confirmation_number_set",
  }).lean<{ metadata: { from: string | null; to: string | null } }[]>();
}

/**
 * A flight written before the booking reference had one home: its PNR in
 * `flight.pnr`, no `confirmationNumber` — inserted straight into the
 * collection, past every validator, exactly as it sits in the database.
 */
async function legacyPnrFlight(
  overrides: Parameters<typeof buildOrder>[0] = {},
): Promise<Types.ObjectId> {
  const doc = buildOrder({
    serviceType: ServiceType.FLIGHT,
    organizationId: brand,
    flight: itineraryFlight({ pnr: "QX7T2L" }),
    confirmationNumber: null,
    ...overrides,
  });
  await Order.collection.insertOne(doc as never);
  return doc._id;
}

/** The historic key order of a genesis row, pinned for car and hotel. */
const HISTORIC_GENESIS_KEYS = [
  "orderNumber",
  "bookingType",
  "customer",
  "provider",
  "serviceType",
  "vehicle",
  "trip",
  "flight",
  "hotel",
  "pricing",
  "charges",
  "chargeBreakdown",
  "terms",
  "policy",
  "createdBy",
  "notes",
];

/* ------------------------------------------------------------------ *
 * Creation: the create form's PNR is the order's booking reference
 * ------------------------------------------------------------------ */

describe("a new flight stores its PNR as the order's one booking reference", () => {
  it("POST /api/orders: flight.pnr → confirmationNumber, never a second copy under flight", async () => {
    const res = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: validFlightOrderInput({}, { pnr: "  XYZ789 " }),
      }),
    );
    const { status, body } = await jsonBody<{ data: { order: { id: string } } }>(res);
    expect(status, JSON.stringify(body)).toBe(201);
    const id = body.data.order.id;

    const dto = await getOrderById(id, { actor });
    expect(dto.confirmationNumber).toBe("XYZ789");
    expect(dto.flight!.pnr).toBeNull();

    const doc = await stored(id);
    expect(doc.confirmationNumber).toBe("XYZ789");
    expect(doc.flight!.pnr ?? null).toBeNull();
  });

  it("freezes the reference into the genesis evidence row — and nowhere else in it", async () => {
    const { order } = await createOrder(validFlightOrderInput({}, { pnr: "XYZ789" }), { actor });
    const payload = await genesisPayload(order.id);
    expect(payload.confirmationNumber).toBe("XYZ789");
    expect((payload.flight as { pnr: string | null }).pnr).toBeNull();
  });

  it("stores no reference — and the genesis row has no such key — when the PNR is left blank", async () => {
    for (const pnr of [null, "", "   "]) {
      const { order } = await createOrder(validFlightOrderInput({}, { pnr }), { actor });
      expect(order.confirmationNumber).toBeNull();
      expect(order.flight!.pnr).toBeNull();
      expect("confirmationNumber" in (await genesisPayload(order.id))).toBe(false);
    }
  });

  it("keeps a car's and a hotel's genesis row in their exact historic shape — no reference key", async () => {
    const { order: car } = await createOrder(validCreateOrderInput(), { actor });
    const { order: hotel } = await createOrder(validHotelOrderInput(), { actor });
    for (const id of [car.id, hotel.id]) {
      const payload = await genesisPayload(id);
      expect(Object.keys(payload)).toEqual(HISTORIC_GENESIS_KEYS);
      expect("confirmationNumber" in payload).toBe(false);
    }
    expect(car.confirmationNumber).toBeNull();
    expect(hotel.confirmationNumber).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Saving a reference: setConfirmationNumber
 * ------------------------------------------------------------------ */

describe("setConfirmationNumber on a flight that kept its PNR in flight.pnr", () => {
  it("stores the new reference, clears the legacy copy, and audits from the PNR the order showed", async () => {
    const id = await legacyPnrFlight();
    expect((await getOrderById(String(id), { actor })).flight!.pnr).toBe("QX7T2L");

    const dto = await setConfirmationNumber(String(id), "AXXXYY", { actor });
    expect(dto.confirmationNumber).toBe("AXXXYY");
    expect(dto.flight!.pnr).toBeNull();

    const doc = await stored(id);
    expect(doc.confirmationNumber).toBe("AXXXYY");
    expect(doc.flight!.pnr).toBeNull();

    const audits = await referenceAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ from: "QX7T2L", to: "AXXXYY" });
  });

  it("returns exactly what getOrderById returns — the operator card caches it as is", async () => {
    // An airline whose logo moved since the order froze its snapshot: the
    // order reads with the live one, and so must the save's answer — even
    // from a cold logo cache.
    await createProvider(
      {
        key: "AIRINDIA",
        name: "Air India",
        logo: "/providers/air-india-old.png",
        primaryColor: "#C8102E",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [ServiceType.FLIGHT],
      } as Parameters<typeof createProvider>[0],
      { actor },
    );
    await Provider.updateOne({ key: "AIRINDIA" }, { $set: { logo: "/providers/air-india-new.png" } });
    const id = await legacyPnrFlight({
      provider: {
        id: "AIRINDIA",
        name: "Air India",
        logo: "/providers/air-india-old.png",
        primaryColor: null,
        onPrimaryColor: null,
      },
    });
    invalidateProviderLogoCache();

    const returned = await setConfirmationNumber(String(id), "AXXXYY", { actor });
    expect(returned.provider.logo).toBe("/providers/air-india-new.png");
    expect(returned).toEqual(await getOrderById(String(id), { actor }));
  });

  it("clears both copies when the field is emptied", async () => {
    const id = await legacyPnrFlight();
    const dto = await setConfirmationNumber(String(id), "   ", { actor });
    expect(dto.confirmationNumber).toBeNull();
    expect(dto.flight!.pnr).toBeNull();
    expect((await referenceAudits(id))[0]!.metadata).toMatchObject({ from: "QX7T2L", to: null });
  });

  it("treats re-saving the PNR it already shows as the no-op it looks like", async () => {
    const id = await legacyPnrFlight();
    const before = await stored(id);

    const dto = await setConfirmationNumber(String(id), " QX7T2L ", { actor });
    expect(dto.flight!.pnr).toBe("QX7T2L");
    expect(dto.confirmationNumber).toBeNull();

    const after = await stored(id);
    expect(after).toEqual(before);
    expect(await referenceAudits(id)).toHaveLength(0);
  });

  it("saves the reference of an old itinerary that today's rules would refuse — the itinerary untouched", async () => {
    // A connection that departs before the previous flight lands: valid
    // when it was placed, refused by today's itinerary rules.
    const id = await legacyPnrFlight({
      flight: itineraryFlight({
        pnr: "QX7T2L",
        outbound: flightJourneyInput([
          FLIGHT_SEGMENTS.delhiVaranasi(),
          flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "11:00"], ["2026-10-10", "13:00"]),
        ]),
      }),
    });
    // The precondition: saving this document with its flight touched
    // re-runs those rules and fails.
    const hydrated = await Order.findById(id);
    hydrated!.flight!.pnr = null;
    await expect(hydrated!.save()).rejects.toThrow(CONNECTION_CHRONOLOGY_MESSAGE);

    const dto = await setConfirmationNumber(String(id), "AXXXYY", { actor });
    expect(dto.confirmationNumber).toBe("AXXXYY");

    const doc = await stored(id);
    expect(doc.confirmationNumber).toBe("AXXXYY");
    expect(doc.flight!.pnr).toBeNull();
    expect(doc.flight!.outbound!.segments[1]!.departure.time).toBe("11:00");
  });

  it("refuses a reference over the stored field's 64 characters, even past the route's schema", async () => {
    const id = await legacyPnrFlight();
    await expect(
      setConfirmationNumber(String(id), "R".repeat(65), { actor }),
    ).rejects.toThrow();
    const doc = await stored(id);
    expect(doc.confirmationNumber ?? null).toBeNull();
    expect(doc.flight!.pnr).toBe("QX7T2L");
  });
});

describe("setConfirmationNumber on a car rental and a hotel — unchanged", () => {
  it.each([
    { service: "car rental", seed: {} },
    { service: "hotel", seed: { serviceType: ServiceType.HOTEL } },
  ])("sets, re-saves as a no-op, and clears a $service's confirmation number", async ({ seed }) => {
    const order = await factoryCreateOrder({ ...seed, organizationId: brand });
    const id = String(order._id);

    const set = await setConfirmationNumber(id, "  SUPP-9F3K2218 ", { actor });
    expect(set.confirmationNumber).toBe("SUPP-9F3K2218");
    // Never grows a flight block: there is no legacy copy to clear.
    expect((await stored(id)).flight ?? null).toBeNull();
    expect(set.flight).toBeNull();

    await setConfirmationNumber(id, "SUPP-9F3K2218", { actor });
    const cleared = await setConfirmationNumber(id, "", { actor });
    expect(cleared.confirmationNumber).toBeNull();

    expect((await referenceAudits(id)).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ from: null, to: "SUPP-9F3K2218" }),
      expect.objectContaining({ from: "SUPP-9F3K2218", to: null }),
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The resend audit row names the reference the email carried
 * ------------------------------------------------------------------ */

describe("resendConfirmationEmail audits the order's booking reference", () => {
  it("records a legacy flight's PNR as the reference the resent email carried", async () => {
    const id = await legacyPnrFlight({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 100,
        processedWebhookEventIds: [],
      } as never,
    });
    await resendConfirmationEmail(String(id), { actor });

    const audit = await AuditLog.findOne({
      entityId: String(id),
      "metadata.action": "confirmation_email_resent",
    }).lean<{ metadata: { confirmationNumber: string | null } } | null>();
    expect(audit?.metadata.confirmationNumber).toBe("QX7T2L");
  });
});

/* ------------------------------------------------------------------ *
 * Search finds an order by its booking reference
 * ------------------------------------------------------------------ */

function search(q: string) {
  return listOrders(
    { q, state: RecordState.ACTIVE, page: 1, pageSize: 50 } as ListOrdersQuery,
    { actor },
  );
}

describe("listOrders finds an order by its booking reference", () => {
  it("finds a flight by its PNR — whole, partial, any case", async () => {
    // "0" and "1" never occur in a generated order number's random part, so
    // these fragments can only match the PNR.
    const { order } = await createOrder(validFlightOrderInput({}, { pnr: "X01Y9K" }), { actor });
    await createOrder(validFlightOrderInput({}, { pnr: "B10ZZQ" }), { actor });
    for (const q of ["X01Y9K", "x01y9k", "01Y9"]) {
      expect((await search(q)).items.map((o) => o.id)).toEqual([order.id]);
    }
  });

  it("finds a flight that still keeps its PNR in flight.pnr", async () => {
    const id = await legacyPnrFlight();
    expect((await search("QX7T2L")).items.map((o) => o.id)).toEqual([String(id)]);
  });

  it("finds a hotel and a car rental by their confirmation numbers", async () => {
    const hotel = await factoryCreateOrder({
      serviceType: ServiceType.HOTEL,
      organizationId: brand,
      confirmationNumber: "83920174",
    });
    const car = await factoryCreateOrder({
      organizationId: brand,
      confirmationNumber: "SUPP-9F3K2218",
    });
    expect((await search("83920174")).items.map((o) => o.id)).toEqual([String(hotel._id)]);
    expect((await search("supp-9f3k")).items.map((o) => o.id)).toEqual([String(car._id)]);
  });

  it("still escapes the search text — a reference-shaped pattern matches only itself", async () => {
    await createOrder(validFlightOrderInput({}, { pnr: "XYZ789" }), { actor });
    expect((await search("XYZ.89")).items).toEqual([]);
    expect((await search("X.*")).items).toEqual([]);
  });

  it("keeps every car search it had: company, model, customer, order number", async () => {
    const car = await factoryCreateOrder({
      organizationId: brand,
      vehicle: { company: "Toyota", type: "Corolla" },
      customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550100" },
    });
    const id = String(car._id);
    for (const q of ["Toyota", "corolla", "Ada Love", "ada@payops", car.orderNumber]) {
      expect((await search(q)).items.map((o) => o.id)).toEqual([id]);
    }
    expect((await search("no-such-reference")).items).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * An older flight holding TWO different references keeps both
 * ------------------------------------------------------------------ */

describe("an older flight with its airline PNR AND a different pasted supplier number", () => {
  // Before this pass the create form stored the PNR in flight.pnr and the
  // order page's card ("Paste the supplier confirmation number") stored a
  // separate value in confirmationNumber. Such an order must keep both.
  const both = () => legacyPnrFlight({ confirmationNumber: "SUPP-55555" });

  it("editing the pasted number never erases the airline PNR — and the audit names what was edited", async () => {
    const id = await both();
    await setConfirmationNumber(String(id), "SUPP-77777", { actor });

    const doc = await stored(id);
    expect(doc.confirmationNumber).toBe("SUPP-77777");
    expect(doc.flight?.pnr).toBe("QX7T2L");
    const audits = await referenceAudits(id);
    expect(audits.map((a) => ({ from: a.metadata.from, to: a.metadata.to }))).toEqual([
      { from: "SUPP-55555", to: "SUPP-77777" },
    ]);
  });

  it("clearing the pasted number keeps the PNR, which is then the order's one reference", async () => {
    const id = await both();
    const dto = await setConfirmationNumber(String(id), "", { actor });

    const doc = await stored(id);
    expect(doc.confirmationNumber ?? null).toBeNull();
    expect(doc.flight?.pnr).toBe("QX7T2L");
    expect(dto.flight?.pnr).toBe("QX7T2L");
  });

  it("resends a confirmation showing both: the supplier number at the top as 'Confirmation number', the airline PNR in its 'PNR' row", async () => {
    const id = await legacyPnrFlight({
      confirmationNumber: "SUPP-55555",
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 100,
        processedWebhookEventIds: [],
      } as never,
    });
    await resendConfirmationEmail(String(id), { actor });

    const evidence = await Order.db
      .collection("order_evidence")
      .find({ orderId: id, eventType: "CONFIRMATION_EMAIL_SENT" })
      .toArray();
    expect(evidence).toHaveLength(1);
    const text = String((evidence[0] as { payload?: { html?: string } }).payload?.html ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(text).toMatch(/Confirmation number\s+SUPP-55555/);
    expect(text).toMatch(/PNR\s+QX7T2L/);
    // The supplier number is never presented as the PNR.
    expect(text).not.toMatch(/PNR\s+SUPP-55555/);
  });
});
