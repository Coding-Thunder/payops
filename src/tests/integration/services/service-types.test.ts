import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder, getOrderById, listOrders } from "@/server/services/order.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import {
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * Flights and hotels end to end through the real `createOrder`, and the
 * proof that adding them changed nothing about car rentals.
 *
 * The two halves matter equally. A flight order has to persist its flight
 * block and leave `vehicle`/`trip` null — the rental sub-documents are
 * conditionally required, so a mis-wired branch either drops the flight
 * payload or refuses to save at all. And the incumbent path has to survive
 * two distinct shapes of "no service type": a CLIENT that never sends the
 * key (both production create-order forms), and a STORED ROW that predates
 * the field (every order in both production databases).
 */

const actor = actorFor(UserRole.ADMIN);

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let multiServiceOrg: Types.ObjectId;
let rentalOnlyOrg: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  isDefault: boolean;
  serviceTypes: ServiceType[];
}): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: `${opts.slug} brand`,
    isDefault: opts.isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: opts.serviceTypes,
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

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(
    orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {},
  );
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  rentalOnlyOrg = await makeOrg({
    slug: "rentalconfirmation",
    isDefault: true,
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  multiServiceOrg = await makeOrg({
    slug: "globevista",
    isDefault: false,
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

/* ------------------------------------------------------------------ *
 * Requirement 5 — FLIGHT end to end
 * ------------------------------------------------------------------ */

describe("requirement 5: serviceType FLIGHT works end to end through createOrder", () => {
  it("persists the flight payload and leaves vehicle and trip null", async () => {
    actingAs(multiServiceOrg);
    const input = validFlightOrderInput();
    const { order } = await createOrder(input, { actor });

    const doc = await Order.findById(order.id).lean<{
      serviceType?: string;
      vehicle?: unknown;
      trip?: unknown;
      hotel?: unknown;
      flight?: {
        tripType: string;
        airline: string | null;
        flightNumber: string | null;
        origin: string;
        destination: string;
        departureDate: Date;
        returnDate: Date | null;
        cabinClass: string;
        passengers: { adults: number; children: number; infants: number };
      };
    } | null>();

    expect(doc).toBeTruthy();
    expect(doc!.serviceType).toBe(ServiceType.FLIGHT);

    // The rental sub-documents are conditionally required — required only
    // when the order IS a car rental. A flight must carry neither.
    expect(doc!.vehicle ?? null).toBeNull();
    expect(doc!.trip ?? null).toBeNull();
    expect(doc!.hotel ?? null).toBeNull();

    expect(doc!.flight!.tripType).toBe("ONE_WAY");
    expect(doc!.flight!.origin).toBe(input.flight.origin);
    expect(doc!.flight!.destination).toBe(input.flight.destination);
    expect(doc!.flight!.airline).toBe(input.flight.airline);
    expect(doc!.flight!.flightNumber).toBe(input.flight.flightNumber);
    expect(doc!.flight!.cabinClass).toBe("ECONOMY");
    expect(doc!.flight!.passengers.adults).toBe(1);
    // Dates are stored as Dates, not the ISO strings that came in.
    expect(doc!.flight!.departureDate).toBeInstanceOf(Date);
    expect(new Date(doc!.flight!.departureDate).toISOString()).toBe(
      input.flight.departureDate,
    );
    expect(doc!.flight!.returnDate ?? null).toBeNull();
  });

  it("reads back through getOrderById as a FLIGHT with a flight block and no vehicle or trip", async () => {
    actingAs(multiServiceOrg);
    const input = validFlightOrderInput();
    const { order } = await createOrder(input, { actor });

    const dto = await getOrderById(order.id, { actor });
    expect(dto.serviceType).toBe(ServiceType.FLIGHT);
    expect(dto.vehicle).toBeNull();
    expect(dto.trip).toBeNull();
    expect(dto.hotel).toBeNull();
    expect(dto.flight).toMatchObject({
      tripType: "ONE_WAY",
      origin: input.flight.origin,
      destination: input.flight.destination,
      cabinClass: "ECONOMY",
    });
    expect(dto.pricing.amount).toBe(420.5);
    expect(dto.status).toBe(OrderStatus.NOT_INITIATED);
  });

  it("persists a ROUND_TRIP return date", async () => {
    actingAs(multiServiceOrg);
    const base = validFlightOrderInput();
    const returnDate = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { order } = await createOrder(
      validFlightOrderInput({
        flight: { ...base.flight, tripType: "ROUND_TRIP", returnDate },
      }),
      { actor },
    );

    const dto = await getOrderById(order.id, { actor });
    expect(dto.flight!.tripType).toBe("ROUND_TRIP");
    expect(dto.flight!.returnDate).toBe(returnDate);
  });

  it("is filterable by serviceType on the orders list", async () => {
    actingAs(multiServiceOrg);
    const { order: flight } = await createOrder(validFlightOrderInput(), {
      actor,
    });
    const { order: rental } = await createOrder(validCreateOrderInput(), {
      actor,
    });

    const flights = await listOrders(
      { page: 1, pageSize: 50, serviceType: ServiceType.FLIGHT } as never,
      { actor },
    );
    expect(flights.items.map((o) => o.id)).toEqual([flight.id]);
    expect(flights.items.map((o) => o.id)).not.toContain(rental.id);
  });

  it("refuses a flight order with no organization selected", async () => {
    // An unowned order resolves to the DEPLOYMENT Stripe account. For a
    // pre-migration car rental that is the historic behaviour; for a flight
    // it would be one brand's money in another brand's merchant account.
    actingAs(null);
    await expect(
      createOrder(validFlightOrderInput(), { actor }),
    ).rejects.toThrow(/Select an organization/i);
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 6 — HOTEL end to end
 * ------------------------------------------------------------------ */

describe("requirement 6: serviceType HOTEL works end to end through createOrder", () => {
  it("persists the hotel payload and leaves vehicle and trip null", async () => {
    actingAs(multiServiceOrg);
    const input = validHotelOrderInput();
    const { order } = await createOrder(input, { actor });

    const doc = await Order.findById(order.id).lean<{
      serviceType?: string;
      vehicle?: unknown;
      trip?: unknown;
      flight?: unknown;
      hotel?: {
        destination: string;
        propertyName: string | null;
        checkInDate: Date;
        checkOutDate: Date;
        rooms: number;
        guests: { adults: number; children: number };
        roomPreference: string | null;
      };
    } | null>();

    expect(doc).toBeTruthy();
    expect(doc!.serviceType).toBe(ServiceType.HOTEL);
    expect(doc!.vehicle ?? null).toBeNull();
    expect(doc!.trip ?? null).toBeNull();
    expect(doc!.flight ?? null).toBeNull();

    expect(doc!.hotel!.destination).toBe(input.hotel.destination);
    expect(doc!.hotel!.propertyName).toBe(input.hotel.propertyName);
    expect(doc!.hotel!.rooms).toBe(1);
    expect(doc!.hotel!.guests.adults).toBe(2);
    expect(doc!.hotel!.roomPreference).toBe(input.hotel.roomPreference);
    expect(doc!.hotel!.checkInDate).toBeInstanceOf(Date);
    expect(new Date(doc!.hotel!.checkInDate).toISOString()).toBe(
      input.hotel.checkInDate,
    );
    expect(new Date(doc!.hotel!.checkOutDate).toISOString()).toBe(
      input.hotel.checkOutDate,
    );
  });

  it("reads back through getOrderById as a HOTEL with a hotel block and no vehicle or trip", async () => {
    actingAs(multiServiceOrg);
    const input = validHotelOrderInput();
    const { order } = await createOrder(input, { actor });

    const dto = await getOrderById(order.id, { actor });
    expect(dto.serviceType).toBe(ServiceType.HOTEL);
    expect(dto.vehicle).toBeNull();
    expect(dto.trip).toBeNull();
    expect(dto.flight).toBeNull();
    expect(dto.hotel).toMatchObject({
      destination: input.hotel.destination,
      propertyName: input.hotel.propertyName,
      rooms: 1,
    });
    expect(dto.pricing.amount).toBe(640);
  });

  it("is filterable by serviceType on the orders list", async () => {
    actingAs(multiServiceOrg);
    const { order: hotel } = await createOrder(validHotelOrderInput(), {
      actor,
    });
    await createOrder(validFlightOrderInput(), { actor });

    const hotels = await listOrders(
      { page: 1, pageSize: 50, serviceType: ServiceType.HOTEL } as never,
      { actor },
    );
    expect(hotels.items.map((o) => o.id)).toEqual([hotel.id]);
  });

  it("refuses a hotel order with no organization selected", async () => {
    actingAs(null);
    await expect(
      createOrder(validHotelOrderInput(), { actor }),
    ).rejects.toThrow(/Select an organization/i);
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 7 — CAR_RENTAL continues to work, both shapes
 * ------------------------------------------------------------------ */

describe("requirement 7: serviceType CAR_RENTAL continues to work unchanged", () => {
  it("creates a car rental from an input with NO serviceType key at all", async () => {
    // This is byte-for-byte the payload both production create-order forms
    // submit today. It must not need to know the field exists.
    const input = validCreateOrderInput();
    expect("serviceType" in input).toBe(false);

    actingAs(rentalOnlyOrg);
    const { order } = await createOrder(input, { actor });

    const doc = await Order.findById(order.id).lean<{
      serviceType?: string;
      vehicle?: { company: string; type: string };
      trip?: { pickupDate: Date; dropoffDate: Date; pickupLocation: string };
      flight?: unknown;
      hotel?: unknown;
    } | null>();

    expect(doc!.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(doc!.vehicle!.company).toBe("Toyota");
    expect(doc!.vehicle!.type).toBe("Camry");
    expect(doc!.trip!.pickupLocation).toBe(input.trip.pickupLocation);
    expect(new Date(doc!.trip!.pickupDate).toISOString()).toBe(
      input.trip.pickupDate,
    );
    expect(doc!.flight ?? null).toBeNull();
    expect(doc!.hotel ?? null).toBeNull();
  });

  it("reads that order back as a CAR_RENTAL with its vehicle and trip intact", async () => {
    actingAs(rentalOnlyOrg);
    const input = validCreateOrderInput();
    const { order } = await createOrder(input, { actor });

    const dto = await getOrderById(order.id, { actor });
    expect(dto.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(dto.vehicle).toMatchObject({ company: "Toyota", type: "Camry" });
    expect(dto.trip).toMatchObject({
      pickupLocation: input.trip.pickupLocation,
      dropoffLocation: input.trip.dropoffLocation,
    });
    expect(dto.flight).toBeNull();
    expect(dto.hotel).toBeNull();
  });

  it("still creates a car rental with NO organization selected, as it always did", async () => {
    // The guard that refuses an unowned flight/hotel must not have been
    // widened to rentals: an unmigrated deployment still writes these.
    actingAs(null);
    const { order } = await createOrder(validCreateOrderInput(), { actor });

    const doc = await Order.findById(order.id).lean<{
      organizationId?: Types.ObjectId | null;
      serviceType?: string;
    } | null>();
    expect(doc!.organizationId ?? null).toBeNull();
    expect(doc!.serviceType).toBe(ServiceType.CAR_RENTAL);
  });

  describe("a PRE-MIGRATION row, stored with no serviceType field at all", () => {
    /**
     * Written through the RAW driver on purpose. `Order.create` would apply
     * the schema default and produce a document that is not what production
     * actually holds — every existing order was written before the field
     * existed and has no such key.
     */
    async function insertPreMigrationRow(): Promise<Types.ObjectId> {
      actingAs(rentalOnlyOrg);
      const { order } = await createOrder(validCreateOrderInput(), { actor });
      const template = await Order.findById(order.id).lean<
        Record<string, unknown>
      >();
      expect(template!.serviceType).toBe(ServiceType.CAR_RENTAL);

      const legacyId = new Types.ObjectId();
      const legacy: Record<string, unknown> = {
        ...template!,
        _id: legacyId,
        orderNumber: "TST-LEGACY-1",
      };
      delete legacy.serviceType;
      // Also absent on a pre-migration row: the manual-capture fields.
      delete legacy.bookingStatus;
      await Order.collection.insertOne(legacy as never);

      const stored = await Order.collection.findOne({ _id: legacyId });
      expect(stored).toBeTruthy();
      expect("serviceType" in stored!).toBe(false);
      return legacyId;
    }

    it("HYDRATES as a car rental", async () => {
      const legacyId = await insertPreMigrationRow();

      const doc = await Order.findById(legacyId);
      expect(doc).toBeTruthy();
      expect(doc!.serviceType).toBe(ServiceType.CAR_RENTAL);
      expect(doc!.vehicle!.company).toBe("Toyota");
      expect(doc!.trip).toBeTruthy();
    });

    it("VALIDATES", async () => {
      const legacyId = await insertPreMigrationRow();
      const doc = await Order.findById(legacyId);
      // The rental sub-documents are required iff the order is a car
      // rental; a row with no serviceType must resolve to CAR_RENTAL and
      // satisfy that, not fail as "vehicle is required" on an unknown type.
      await expect(doc!.validate()).resolves.toBeUndefined();
    });

    it("RE-SAVES", async () => {
      const legacyId = await insertPreMigrationRow();
      const doc = await Order.findById(legacyId);
      doc!.notes = "Touched by an operator after the migration.";
      await expect(doc!.save()).resolves.toBeTruthy();

      const after = await Order.findById(legacyId).lean<{
        notes: string | null;
        serviceType?: string;
        vehicle?: { company: string };
      } | null>();
      expect(after!.notes).toBe("Touched by an operator after the migration.");
      // The re-save materialises the default, which is the correct value.
      expect(after!.serviceType ?? ServiceType.CAR_RENTAL).toBe(
        ServiceType.CAR_RENTAL,
      );
      expect(after!.vehicle!.company).toBe("Toyota");
    });

    it("reads back through getOrderById as a CAR_RENTAL even while the field is absent", async () => {
      // `.lean()` does NOT apply Mongoose defaults, so the DTO layer has to
      // supply the fallback itself. Without it the operator UI would render
      // a service type of `undefined` for every historical order.
      const legacyId = await insertPreMigrationRow();

      const dto = await getOrderById(String(legacyId), { actor });
      expect(dto.serviceType).toBe(ServiceType.CAR_RENTAL);
      expect(dto.vehicle).toMatchObject({ company: "Toyota" });
      expect(dto.trip).toBeTruthy();
      expect(dto.flight).toBeNull();
      expect(dto.hotel).toBeNull();
    });

    it("is returned by a CAR_RENTAL serviceType filter", async () => {
      const legacyId = await insertPreMigrationRow();

      const listed = await listOrders(
        { page: 1, pageSize: 50, serviceType: ServiceType.CAR_RENTAL } as never,
        { actor },
      );
      expect(listed.items.map((o) => o.id)).toContain(String(legacyId));
    });
  });
});
