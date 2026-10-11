import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";

import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import {
  ConsentMode,
  ConsentStatus,
  EmailKind,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ConflictError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { serviceDetailRows } from "@/lib/service-summary";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  PaymentConsent,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDay } from "@/server/email/format";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import {
  getPublicConsentView,
  recordConsentFromToken,
} from "@/server/services/consent.service";
import {
  createOrder,
  getOrderById,
  initiatePayment,
  setConfirmationNumber,
} from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import { validHotelOrderInput } from "@/tests/fixtures/order-input.fixture";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO, PaymentConsentHotelSnapshot } from "@/types";

/**
 * A HOTEL, on every surface its customer reads — for a PayPal brand that
 * sells car rentals, flights and hotels, set up the way such a brand is:
 * its own PayPal account, its own hotel supplier.
 *
 *   - The payment request words the money as a stay: the prepaid row is
 *     "Amount payable now" (nothing is paid yet), the balance is due "at the
 *     property", the total is "Total hotel cost". Its buttons and subject
 *     are a car's — only a flight's name its charge.
 *   - The confirmation opens with the HOTEL's confirmation number, under
 *     that name, and keeps "Amount paid online".
 *   - The consent page shows the stay the customer confirms — property,
 *     destination, the two calendar days, rooms, guests and the room
 *     preference — from a stay frozen into the consent record, through the
 *     same rows every other surface uses. The guest notes are the
 *     operator's: never frozen, never shown. A record frozen before stays
 *     were renders exactly as before.
 *   - A consent request never fails on a long property name, and an email
 *     never carries a dead consent link: if the record cannot be saved,
 *     advisory consent sends the checkout button and required consent
 *     refuses to send at all.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<deployment>", response: "250 OK" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<organization>", response: "250 OK" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const {
  composePaymentRequestProps,
  sendPaymentConfirmationEmail,
  sendPaymentRequestEmail,
} = await import("@/server/services/email.service");

const actor = actorFor(UserRole.ADMIN);

const ORG_ENV: Record<string, string> = {
  ORG_TRIPSTAYS_PAYPAL_CLIENT_ID: "test-client-id",
  ORG_TRIPSTAYS_PAYPAL_CLIENT_SECRET: "test-client-secret",
  ORG_TRIPSTAYS_PAYPAL_WEBHOOK_ID: "TESTWEBHOOK",
  ORG_TRIPSTAYS_PAYPAL_SANDBOX: "true",
};

const SUPPLIER = "Harbour Stays";
const PROPERTY = "Harbour View Hotel";
const DESTINATION = "Lisbon, Portugal";
const ROOM_PREFERENCE = "King bed, high floor";
/** The operator's own note — it must never reach the customer. */
const GUEST_NOTES = "VIP guest, upgrade if available";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let tripstays: Types.ObjectId;
let paypalOrders = 0;

/** A calendar day `offset` days from today, as the create form posts it. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

const CHECK_IN = day(30);
const CHECK_OUT = day(33);

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** Minimal PayPal API: OAuth, then order creation. */
function stubPayPal() {
  paypalOrders = 0;
  _setPayPalFetchForTesting((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    paypalOrders += 1;
    const id = `PP-STAY-${paypalOrders}`;
    return new Response(
      JSON.stringify({
        id,
        status: "PAYER_ACTION_REQUIRED",
        links: [
          { rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  stubPayPal();
  const org = await Organization.create({
    slug: "tripstays",
    name: "tripstays",
    brandName: "Trip Stays",
    isDefault: false,
    payments: { provider: PaymentGatewayKey.PAYPAL },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
    email: {
      fromName: "Trip Stays",
      fromEmail: "no-reply@tripstays.test",
      replyTo: "help@tripstays.test",
    },
    support: { email: "support@tripstays.test", phone: "" },
  });
  tripstays = org._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: tripstays,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  actingAs(tripstays);
  await createProvider(
    {
      key: "HARBOURSTAYS",
      name: SUPPLIER,
      logo: "/providers/preview.png",
      primaryColor: "#0B3D91",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.HOTEL],
    } as Parameters<typeof createProvider>[0],
    { actor },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of Object.keys(ORG_ENV)) delete process.env[k];
  setNextHeaders({});
});

/** The create form's hotel: three nights, a prepaid room charge and a
 *  resort fee settled at the property. */
function hotelInput(over: { propertyName?: string; destination?: string } = {}) {
  return validHotelOrderInput({
    provider: "HARBOURSTAYS",
    hotel: {
      destination: over.destination ?? DESTINATION,
      propertyName: over.propertyName ?? PROPERTY,
      checkInDate: CHECK_IN,
      checkOutDate: CHECK_OUT,
      rooms: 1,
      guests: { adults: 2, children: 0 },
      roomPreference: ROOM_PREFERENCE,
      guestNotes: GUEST_NOTES,
    },
    charges: [
      { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
      { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });
}

/** Create the hotel in Trip Stays and generate its PayPal link. */
async function linkedHotel(input = hotelInput()): Promise<OrderDTO> {
  actingAs(tripstays);
  const { order } = await createOrder(input, { actor });
  const { order: linked } = await initiatePayment(order.id, { actor });
  expect(linked.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
  return linked;
}

function lastSent(kind: EmailKind) {
  const msg = [...sentMail]
    .reverse()
    .find((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind);
  expect(msg, `no ${kind} email was sent`).toBeTruthy();
  return { subject: String(msg!.subject), html: String(msg!.html), text: String(msg!.text) };
}

/** Rendered HTML as a reader sees it: tags dropped, React's text-node
 *  separators and entities undone, whitespace collapsed. */
function readable(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The stay's shared rows as a reader sees them, label then value. */
function rowsText(rows: Array<{ label: string; value: string }>): string {
  return rows.map((r) => `${r.label} ${r.value}`).join(" ");
}

/** The hosted consent page the email's button opens, as the customer
 *  (no session, no organization) sees it. */
async function consentPage(token: string): Promise<string> {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
  const html = renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
  sessionMock = await mockSession(actor);
  actingAs(tripstays);
  return readable(html);
}

/* ------------------------------------------------------------------ *
 * The payment request
 * ------------------------------------------------------------------ */

describe("a hotel's payment request", () => {
  it("words its money as a stay: 'Amount payable now' — nothing is paid yet — then 'Amount due at the property' and 'Total hotel cost'", async () => {
    await sendPaymentRequestEmail(await linkedHotel(), {}, { actor });
    const request = lastSent(EmailKind.PAYMENT_LINK);
    const text = readable(request.html);
    expect(text).toContain(
      "What you're paying Room charge $300.00 Resort fee (due at the property) $50.00 " +
        "Amount payable now $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
    );
    expect(text).toContain("You pay today $300.00");
    for (const body of [request.html, request.text]) {
      expect(body).not.toContain("Amount paid online");
      expect(body).not.toContain("counter");
      expect(body.toLowerCase()).not.toContain("rental");
      expect(body).not.toContain("Total stay cost");
    }
  });

  it("keeps a car's buttons and subject — only a flight's name its charge", async () => {
    const linked = await linkedHotel();
    await sendPaymentRequestEmail(linked, {}, { actor });
    const request = lastSent(EmailKind.PAYMENT_LINK);
    expect(request.subject).toBe(`Complete your ${SUPPLIER} payment • ${linked.orderNumber}`);
    expect(readable(request.html)).toContain("Review & Confirm Booking");

    await Order.updateOne(
      { _id: linked.id },
      { $set: { "consent.status": ConsentStatus.RECEIVED } },
    );
    const props = await composePaymentRequestProps(await getOrderById(linked.id, { actor }));
    expect(props.primaryCta?.label).toBe("Pay $300.00 securely with PayPal →");
  });

  it("shows the customer the stay — the room preference included, the operator's guest notes never", async () => {
    const linked = await linkedHotel();
    await sendPaymentRequestEmail(linked, {}, { actor });
    const request = lastSent(EmailKind.PAYMENT_LINK);
    const rows = serviceDetailRows(linked, formatEmailDay);
    expect(readable(request.html)).toContain(rowsText(rows));
    expect(readable(request.html)).toContain(`Room preference ${ROOM_PREFERENCE}`);
    for (const body of [request.html, request.text]) {
      expect(body).not.toContain(GUEST_NOTES);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The confirmation
 * ------------------------------------------------------------------ */

describe("a hotel's confirmation", () => {
  it("opens with the hotel's own number under 'Hotel confirmation number', and keeps 'Amount paid online'", async () => {
    const linked = await linkedHotel();
    await setConfirmationNumber(linked.id, "83920174", { actor });
    await sendPaymentConfirmationEmail(await getOrderById(linked.id, { actor }));

    const confirmation = lastSent(EmailKind.PAYMENT_CONFIRMATION);
    const text = readable(confirmation.html);
    expect(text).toContain(
      `please keep this email for your records. Hotel confirmation number 83920174 ${SUPPLIER} New booking Booking details`,
    );
    expect(text.split("83920174")).toHaveLength(2);
    expect(text).toContain(
      "Charge breakdown Room charge $300.00 Resort fee (due at the property) $50.00 " +
        "Amount paid online $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
    );
    expect(text).toContain(`Room preference ${ROOM_PREFERENCE}`);
    expect(confirmation.html).not.toContain(GUEST_NOTES);
  });
});

/* ------------------------------------------------------------------ *
 * The hosted consent page
 * ------------------------------------------------------------------ */

describe("the hosted consent page shows the stay the customer confirms", () => {
  /** Send the request; return the order, its token and its stored record. */
  async function requested() {
    const linked = await linkedHotel();
    const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor });
    expect(consentToken, "the send recorded no consent request").toBeTruthy();
    const record = await PaymentConsent.findOne({
      orderId: new Types.ObjectId(linked.id),
    }).lean<{ _id: Types.ObjectId; snapshot: Record<string, unknown> } | null>();
    return { order: linked, token: consentToken!, record: record! };
  }

  const FROZEN_STAY: PaymentConsentHotelSnapshot = {
    destination: DESTINATION,
    propertyName: PROPERTY,
    checkInDate: `${CHECK_IN}T00:00:00.000Z`,
    checkOutDate: `${CHECK_OUT}T00:00:00.000Z`,
    rooms: 1,
    guests: { adults: 2, children: 0 },
    roomPreference: ROOM_PREFERENCE,
  };

  it("freezes the stay into the consent record — never the guest notes", async () => {
    const { token, record } = await requested();
    expect(record.snapshot.hotel).toEqual(FROZEN_STAY);
    expect(JSON.stringify(record)).not.toContain(GUEST_NOTES);
    expect((await getPublicConsentView(token, { brandName: "x" })).snapshot.hotel).toEqual(
      FROZEN_STAY,
    );
  });

  it("renders it from the shared rows — calendar days, no clock time — under 'Total hotel cost'", async () => {
    const { token } = await requested();
    const text = await consentPage(token);

    expect(text).toContain(
      rowsText(serviceDetailRows({ serviceType: ServiceType.HOTEL, hotel: FROZEN_STAY })),
    );
    expect(text).toContain(`Property ${PROPERTY} Destination ${DESTINATION} Check-in`);
    expect(text).toContain(`Room preference ${ROOM_PREFERENCE}`);
    expect(text).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(text).toContain(
      "Paid online today $300.00 Remaining balance due at the property $50.00 Total hotel cost $350.00",
    );
    expect(text).not.toContain("Total stay cost");
    expect(text).not.toContain(GUEST_NOTES);
    // The supplier row is worded as on every other hotel surface.
    expect(text).toMatch(/Hotel \/ Supplier \S/);
    expect(text).not.toMatch(/\bProvider\b/);
    // A hotel's button is a car's — only a flight's names its charge.
    expect(text).toContain("Confirm & Continue to Payment");
    expect(text).toContain("secure PayPal checkout");
  });

  it("records the stay the customer saw in the request's and the acknowledgement's evidence", async () => {
    const { order, token } = await requested();
    const evidence = (eventType: OrderEvidenceEventType) =>
      OrderEvidence.findOne({ orderId: new Types.ObjectId(order.id), eventType }).lean<{
        payload: { snapshot: Record<string, unknown> };
      } | null>();

    expect((await evidence(OrderEvidenceEventType.CONSENT_REQUESTED))!.payload.snapshot.stay).toEqual(
      FROZEN_STAY,
    );
    await recordConsentFromToken(
      {
        token,
        acknowledgement: (await getPublicConsentView(token, { brandName: "x" })).consentMessage,
        signedName: "Katherine Johnson",
      },
      { branding: { brandName: "x" } },
    );
    expect((await evidence(OrderEvidenceEventType.CONSENT_RECEIVED))!.payload.snapshot.stay).toEqual(
      FROZEN_STAY,
    );
  });

  it("renders a hotel record frozen BEFORE stays were exactly as before — the folded item and dates", async () => {
    const { token, record } = await requested();
    // As every hotel consent written before the stay was frozen is stored.
    await PaymentConsent.collection.updateOne(
      { _id: record._id },
      { $unset: { "snapshot.hotel": "" } },
    );
    const view = await getPublicConsentView(token, { brandName: "x" });
    expect("hotel" in view.snapshot).toBe(false);

    const text = await consentPage(token);
    expect(text).toContain(`Property ${PROPERTY} • ${DESTINATION}`);
    expect(text).toContain(
      `Check-in ${formatDateTime(view.snapshot.pickupDate)} · ${DESTINATION}`,
    );
    expect(text).toContain(
      `Check-out ${formatDateTime(view.snapshot.dropoffDate)} · ${DESTINATION}`,
    );
    expect(text).not.toContain("Room preference");
    expect(text).not.toContain("Destination");
  });
});

/* ------------------------------------------------------------------ *
 * A consent request never fails, an email never carries a dead link
 * ------------------------------------------------------------------ */

describe("a hotel's consent link always works", () => {
  it("persists the consent of a 138-character property beside a 56-character destination — and the button opens /consent/<token>", async () => {
    const propertyName = `The Grand ${"Harbourside ".repeat(10)}Residences & Spa`.slice(0, 138);
    const destination = "Lisbon, Portugal — Baixa-Chiado, Rua Garrett district 12".slice(0, 56);
    expect(propertyName).toHaveLength(138);
    expect(destination).toHaveLength(56);

    const linked = await linkedHotel(hotelInput({ propertyName, destination }));
    const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor });

    expect(consentToken, "the consent record was refused").toBeTruthy();
    const record = await PaymentConsent.findOne({ orderId: new Types.ObjectId(linked.id) }).lean();
    expect(record?.snapshot.vehicle).toHaveLength(160);
    expect(record?.snapshot.hotel?.propertyName).toBe(propertyName);
    const html = lastSent(EmailKind.PAYMENT_LINK).html;
    expect(html).toContain(`/consent/${consentToken}`);
    expect(html).not.toContain("/consent/preview");
  });

  it("advisory consent: when the record cannot be saved, the button opens PayPal checkout — never /consent/preview", async () => {
    const linked = await linkedHotel();
    vi.spyOn(PaymentConsent, "create").mockRejectedValueOnce(new Error("simulated write failure"));

    const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor });

    expect(consentToken).toBeNull();
    const request = lastSent(EmailKind.PAYMENT_LINK);
    expect(request.html).not.toContain("/consent/");
    expect(request.html).toContain(`href="${linked.payment.paymentUrl}"`);
    expect(readable(request.html)).toContain("Pay $300.00 securely with PayPal →");
    const row = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(linked.id),
      eventType: OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    }).lean<{ payload: { cta: { url: string; label: string } } } | null>();
    expect(row!.payload.cta).toMatchObject({
      url: linked.payment.paymentUrl,
      label: "Pay $300.00 securely with PayPal →",
    });
  });

  it("required consent: when the record cannot be saved, the send is refused — nothing reaches the customer", async () => {
    await createSettings({ consentMode: ConsentMode.REQUIRED });
    const linked = await linkedHotel();
    vi.spyOn(PaymentConsent, "create").mockRejectedValueOnce(new Error("simulated write failure"));

    const send = sendPaymentRequestEmail(linked, {}, { actor });

    await expect(send).rejects.toBeInstanceOf(ConflictError);
    await expect(send).rejects.toThrow(/not sent/);
    expect(
      sentMail.filter(
        (m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === EmailKind.PAYMENT_LINK,
      ),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The receipt
 * ------------------------------------------------------------------ */

describe("a hotel's receipt", () => {
  it("shows the stay, the hotel's number under 'Hotel confirmation #', and the stay's money — never the guest notes", async () => {
    const linked = await linkedHotel();
    await setConfirmationNumber(linked.id, "83920174", { actor });
    await Order.updateOne(
      { _id: linked.id },
      {
        $set: {
          status: OrderStatus.PAID,
          "payment.status": OrderStatus.PAID,
          "payment.paidAt": new Date(),
          "payment.amountReceived": 300,
        },
      },
    );

    const html = renderToStaticMarkup(
      await PaymentSuccessPage({
        searchParams: Promise.resolve({
          order: linked.orderNumber,
          token: linked.payment.paymentSessionId!,
        }),
      }),
    );
    const text = readable(html);
    expect(text).toContain(`Room preference ${ROOM_PREFERENCE} Hotel confirmation # 83920174`);
    expect(text).toContain(
      "Charge breakdown Paid online today $300.00 Remaining balance due at the property $50.00 Total hotel cost $350.00",
    );
    expect(text).not.toContain(GUEST_NOTES);
    expect(text).not.toContain("Stripe");
  });
});
