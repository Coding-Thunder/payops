import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";

import {
  BookingStatus,
  CaptureMode,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  MANUAL_CAPTURE_STRIPE_EVENTS,
  stripeWebhookPath,
} from "@/lib/organization-capture-mode";
import {
  Order,
  Organization,
  OrganizationMember,
  type OrderDoc,
} from "@/server/db/models";
import { getOrganizationCaptureMode } from "@/server/services/order.service";
import { createOrder } from "@/tests/factories/order.factory";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * SWITCH AN ORGANIZATION'S CAPTURE MODE — `scripts/set-organization-capture-mode.ts`,
 * run exactly as an operator runs it (`npx tsx`, a REAL child process)
 * against THIS file's in-memory database, and the app reading back what it
 * wrote.
 *
 * THE WORLD (production-shaped, written so no Mongoose default can stand in
 * for an absent key — the absent keys are removed with the raw driver):
 *
 *   rentalconfirmation  "Rental Confirmation", the DEFAULT organization,
 *                       Stripe only, `payments.captureMode` NOT STORED (nor
 *                       `serviceTypes`, nor `legal`). It has no
 *                       ORG_RENTALCONFIRMATION_* secrets: its Stripe events
 *                       arrive at the DEPLOYMENT endpoint
 *                       /api/webhooks/stripe, which alone also accepts the
 *                       orders stored without an organization — orders the
 *                       default organization owns.
 *   tripreservations    "Trip Reservations", PayPal by default with Stripe
 *                       enabled beside it, no capture mode stored
 *   coastaltrips        "Coastal Trips", PayPal ONLY, no capture mode stored
 *   globevista          "FlightBizz", Stripe, `captureMode: MANUAL`
 *
 * plus one member per organization and orders in every state the script
 * reports on: Rental's own, one stored with `organizationId: null`, open
 * charge-at-checkout links, paid orders, and GlobeVista's manual-capture
 * orders — four still live (PENDING_AUTHORIZATION, AUTHORIZED,
 * CAPTURE_PENDING, CAPTURE_FAILED), three settled (CAPTURED, CANCELLED,
 * AUTHORIZATION_EXPIRED).
 *
 * WHAT IS PROVEN, by the script's own output, its exit code, and the raw
 * database before and after (canonical Extended JSON — every BSON type,
 * value and key order, so "unchanged" means the same bytes):
 *
 *   1.  dry run for Rental → MANUAL: the full report, line for line (none
 *       stored, before AUTOMATIC, after MANUAL, the order counts, the
 *       DEPLOYMENT webhook endpoint, every event it must be subscribed to and
 *       the warning that payment_intent.payment_failed also reaches
 *       charge-at-checkout orders) and no write; 1b. APPLY means exactly
 *       "1" — APPLY=true and APPLY=0 are dry runs too
 *   2.  APPLY=1: `payments.captureMode` (and the timestamp) is the only thing
 *       written, on that one document; 2b. even against a database with
 *       none of the app's indexes or collections (production runs
 *       autoIndex:false) it creates no collection and builds no index —
 *       while the app's own connectMongo(), run there as the control, does
 *   3.  idempotent: a re-run is "nothing to change" and writes nothing —
 *       nor does asking for AUTOMATIC where nothing is stored
 *   4.  order counts: the default organization's own count includes its
 *       orders stored without an organization (null or absent); an order
 *       on the manual lifecycle is never counted as an open
 *       charge-at-checkout link, and one already PAID is never a live hold
 *   5.  TripReservations → MANUAL: allowed; PayPal keeps charging at
 *       checkout; its OWN endpoint /api/webhooks/stripe/tripreservations
 *   6.  refusals — exit 1, the reason on stderr, the database untouched:
 *       missing / blank inputs, an unknown mode (refused before the
 *       database is even reached — shown against an unreachable address,
 *       with a control that does reach the connection), an unknown slug,
 *       MANUAL for a PayPal-only brand, MANUAL → AUTOMATIC without
 *       ALLOW_AUTOMATIC (ALLOW_AUTOMATIC=true is no confirmation; the
 *       confirmed switch back works), a stored mode that is not a mode, a
 *       null `payments`
 *   7.  the app honours the write: getOrganizationCaptureMode for Rental's
 *       id AND for a null organization (the default organization's
 *       decision), TripReservations', and the others unchanged
 *   8.  guarded: a mode changed between the script's read and its write
 *       aborts the write and keeps the other writer's value — for a mode
 *       read as none stored and for a stored one. Deterministic, with no
 *       failpoint and no timing: a `tsx -e` wrapper imports the REAL script
 *       after registering one Mongoose plugin that writes, raw, right after
 *       the script's read (Mongoose awaits an async post hook, so the write
 *       lands before the script's update is sent). The same wrapper writing
 *       nothing is the control.
 */

/* ------------------------------------------------------------------ *
 * The deployment, as production has it
 * ------------------------------------------------------------------ */

type OrgKey = "rc" | "trip" | "coast" | "gv";

const RC = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
} as const;

const TRIP = {
  slug: "tripreservations",
  brandName: "Trip Reservations",
  supportEmail: "contact@tripreservations.test",
  fromEmail: "contact@tripreservations.test",
} as const;

/** A PayPal-only brand: no Stripe account at all. */
const COAST = {
  slug: "coastaltrips",
  brandName: "Coastal Trips",
  supportEmail: "help@coastaltrips.test",
} as const;

const GV = {
  slug: "globevista",
  name: "GlobeVista",
  brandName: "FlightBizz",
  supportEmail: "support@flightbizz.test",
  fromEmail: "bookings@flightbizz.test",
} as const;

const ALL_SLUGS = [RC.slug, TRIP.slug, COAST.slug, GV.slug];

/** The Stripe events the manual-capture lifecycle needs — written out
 *  here, not read from the module, so the module cannot drift unseen. */
const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
];

/** The report's endpoint block for a MANUAL result, as the script prints it
 *  — including its warning that subscribing to payment_intent.payment_failed
 *  also reaches charge-at-checkout orders. */
function webhookBlock(endpointPath: string): string[] {
  return [
    `  • Stripe webhook endpoint (this organization's Stripe account): <APP_URL>${endpointPath}`,
    "    It must be subscribed to:",
    ...STRIPE_EVENTS.map((event) => `      ${event}`),
    "    payment_intent.canceled is the only way the app learns that an uncaptured hold has expired.",
    "    payment_intent.payment_failed is not limited to manual capture: if the endpoint is not",
    "    subscribed to it already, adding it also marks a charge-at-checkout order FAILED when a",
    "    card is declined at checkout. Add it deliberately.",
  ];
}

const OPEN_LINK_NOTE =
  "with an open charge-at-checkout link: that link keeps charging at checkout. Don't regenerate these until it has expired";
const LIVE_MANUAL_NOTE =
  "still on the manual lifecycle: each keeps it and still needs Capture or Release";
const SWITCH_BACK_REFUSAL =
  "Switching from MANUAL back to AUTOMATIC: orders already authorized keep the manual lifecycle (each still needs Capture or Release). Set ALLOW_AUTOMATIC=1 as well to confirm.";

const operator = actorFor(UserRole.ADMIN, { name: "Ops Admin" });
const orgIds = {} as Record<OrgKey, Types.ObjectId>;

/** Remove keys with the raw driver: the document then looks exactly like a
 *  production row written before those fields existed. */
async function unsetRaw(orgId: Types.ObjectId, paths: string[]) {
  await Organization.collection.updateOne(
    { _id: orgId },
    { $unset: Object.fromEntries(paths.map((p) => [p, ""])) },
  );
}

async function memberOf(orgId: Types.ObjectId) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
}

async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: RC.slug,
    name: RC.brandName,
    brandName: RC.brandName,
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
    support: { email: RC.supportEmail, phone: RC.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  // No service list, no legal, and NO capture mode: it reads as AUTOMATIC.
  await unsetRaw(id, ["serviceTypes", "legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: TRIP.slug,
    name: TRIP.brandName,
    brandName: TRIP.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL, PaymentGatewayKey.STRIPE],
    },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: {
      fromName: TRIP.brandName,
      fromEmail: TRIP.fromEmail,
      replyTo: "",
      transport: { host: "smtp.gmail.com", port: 587, secure: false, user: TRIP.fromEmail },
    },
    support: { email: TRIP.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await unsetRaw(id, ["legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

async function makeCoastalTrips(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: COAST.slug,
    name: COAST.brandName,
    brandName: COAST.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
    },
    serviceTypes: [ServiceType.CAR_RENTAL],
    support: { email: COAST.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await unsetRaw(id, ["legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

async function makeGlobeVista(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: GV.slug,
    name: GV.name,
    brandName: GV.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
    email: { fromName: GV.brandName, fromEmail: GV.fromEmail, replyTo: "" },
    support: { email: GV.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await memberOf(id);
  return id;
}

/* ------------------------------------------------------------------ *
 * Orders in every state the script counts
 * ------------------------------------------------------------------ */

type CaptureState = NonNullable<OrderDoc["payment"]["capture"]>;

const AMOUNT = 199.5;

/** A manual-capture state as the lifecycle leaves it: the capture
 *  sub-document and the booking status that goes with it. */
function manualCapture(status: PaymentCaptureStatus): {
  capture: CaptureState;
  bookingStatus: BookingStatus;
} {
  const now = new Date();
  const authorized = status !== PaymentCaptureStatus.PENDING_AUTHORIZATION;
  const captured = status === PaymentCaptureStatus.CAPTURED;
  const released =
    status === PaymentCaptureStatus.CANCELLED ||
    status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED;
  return {
    capture: {
      method: CaptureMode.MANUAL,
      status,
      authorizedAt: authorized ? now : null,
      amountAuthorized: authorized ? AMOUNT : null,
      captureExpiresAt: authorized ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) : null,
      capturedAt: captured ? now : null,
      amountCaptured: captured ? AMOUNT : null,
      cancelledAt: released ? now : null,
      cancelReason:
        status === PaymentCaptureStatus.CANCELLED
          ? "Customer changed plans"
          : status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED
            ? "automatic"
            : null,
      lastError: status === PaymentCaptureStatus.CAPTURE_FAILED ? "Your card was declined." : null,
    },
    bookingStatus: captured
      ? BookingStatus.CONFIRMED
      : released
        ? BookingStatus.CANCELLED
        : BookingStatus.PENDING,
  };
}

/** An order of `owner` (null: stored without an organization) through the
 *  real Order model. `captureStatus` makes it a manual-capture order. */
async function seedOrder(
  owner: Types.ObjectId | null,
  status: OrderStatus,
  captureStatus?: PaymentCaptureStatus,
): Promise<Types.ObjectId> {
  const manual = captureStatus ? manualCapture(captureStatus) : null;
  const linked = status !== OrderStatus.NOT_INITIATED;
  const paid = status === OrderStatus.PAID;
  const ref = new Types.ObjectId().toHexString();
  const order = await createOrder({
    organizationId: owner,
    status,
    bookingStatus: manual?.bookingStatus ?? null,
    payment: {
      status,
      stripeSessionId: linked ? `cs_test_${ref}` : null,
      paymentIntentId: linked ? `pi_test_${ref}` : null,
      paidAt: paid ? new Date() : null,
      amountReceived: paid ? AMOUNT : null,
      processedWebhookEventIds: [],
      capture: manual?.capture ?? null,
    },
  });
  return order._id as Types.ObjectId;
}

/** Every organization's orders, as the counts below expect them. */
async function seedOrders() {
  // Rental Confirmation: the default organization owns its own orders AND
  // the one stored with no organization at all.
  await seedOrder(orgIds.rc, OrderStatus.NOT_INITIATED);
  await seedOrder(null, OrderStatus.NOT_INITIATED);
  await seedOrder(orgIds.rc, OrderStatus.LINK_GENERATED); // open charge-at-checkout link
  await seedOrder(orgIds.rc, OrderStatus.PAID);
  // Trip Reservations: none of these is Rental's.
  await seedOrder(orgIds.trip, OrderStatus.NOT_INITIATED);
  await seedOrder(orgIds.trip, OrderStatus.PAYMENT_PENDING); // open charge-at-checkout link
  await seedOrder(orgIds.trip, OrderStatus.PAID);
  // Coastal Trips.
  await seedOrder(orgIds.coast, OrderStatus.NOT_INITIATED);
  // GlobeVista (MANUAL): four holds still live, three settled.
  await seedOrder(orgIds.gv, OrderStatus.NOT_INITIATED);
  await seedOrder(orgIds.gv, OrderStatus.LINK_GENERATED, PaymentCaptureStatus.PENDING_AUTHORIZATION);
  await seedOrder(orgIds.gv, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.AUTHORIZED);
  await seedOrder(orgIds.gv, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.CAPTURE_PENDING);
  await seedOrder(orgIds.gv, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.CAPTURE_FAILED);
  await seedOrder(orgIds.gv, OrderStatus.PAID, PaymentCaptureStatus.CAPTURED);
  await seedOrder(orgIds.gv, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.CANCELLED);
  await seedOrder(orgIds.gv, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.AUTHORIZATION_EXPIRED);
}

/* ------------------------------------------------------------------ *
 * The mechanism: scripts/set-organization-capture-mode.ts, for real
 * ------------------------------------------------------------------ */

const SCRIPT = "scripts/set-organization-capture-mode.ts";

type Knob = "ORG_SLUG" | "CAPTURE_MODE" | "APPLY" | "ALLOW_AUTOMATIC";
const KNOBS: Knob[] = ["ORG_SLUG", "CAPTURE_MODE", "APPLY", "ALLOW_AUTOMATIC"];

interface ScriptRun {
  /** The process's exit code; -1 when it was killed (e.g. timed out). */
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Where the script connects, when not this file's own database. */
interface Target {
  /** 6b only: a port on this machine that nothing listens on. */
  uri?: string;
  /** 2b only: this file's own sibling database on the in-memory server. */
  dbName?: string;
}

/**
 * Run the script exactly as an operator does (`npx tsx`), with this test
 * process's environment — except that MONGODB_URI / MONGODB_DB name THIS
 * file's database on the in-memory server (asserted before anything runs),
 * the runner's own plumbing (VITEST_*, NODE_OPTIONS) is left out, and the
 * four knobs are exactly `knobs` — an inherited one never leaks in. No
 * --env-file: nothing outside this environment is read. `--no-install`
 * makes npx use the local tsx and never the network.
 */
async function runCaptureModeScript(
  knobs: Partial<Record<Knob, string>>,
  target: Target = {},
): Promise<ScriptRun> {
  return runTsx([SCRIPT], knobs, target);
}

/**
 * 2b's control: the APP's own connection — `connectMongo()` (autoIndex on
 * outside production, Mongoose's autoCreate on) with every model
 * registered, i.e. what the script deliberately does not do — in a child
 * process under the same guards. It proves the "no collection, no index"
 * check can see a connection that does create them.
 */
const APP_CONNECTION = [
  "(async () => {",
  '  await import("./src/server/db/models/index.ts");',
  '  const { connectMongo } = await import("./src/server/db/mongoose.ts");',
  '  const mongoose = (await import("mongoose")).default;',
  "  await connectMongo();",
  "  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));",
  "  await mongoose.disconnect();",
  "})().catch((err) => { console.error(err); process.exit(1); });",
].join("\n");

async function runAppConnection(target: Target): Promise<ScriptRun> {
  return runTsx(["-e", APP_CONNECTION], {}, target);
}

/** What 8's second writer prints on stderr, after its write. */
const RACE_MARK = "[race] organization read; concurrent write:";

/**
 * 8's mechanism: the REAL script, imported by a `tsx -e` wrapper (under the
 * same guards) that first registers ONE global Mongoose plugin — nothing in
 * the script is replaced. The plugin plays a second writer: right after the
 * script's read of the organization (its `findOne` by slug; once, never the
 * read-back by id) it applies `concurrentWrite` with the RAW driver (no
 * Mongoose hook, no timestamp), then prints RACE_MARK and the write on
 * stderr. Mongoose awaits an async post hook, so the write has landed before
 * the script's guarded update is sent. With `concurrentWrite` null it writes
 * nothing: the control that the wrapper itself changes nothing.
 */
async function runWithConcurrentWrite(
  knobs: Partial<Record<Knob, string>>,
  concurrentWrite: Record<string, unknown> | null,
): Promise<ScriptRun> {
  const wrapper = [
    "(async () => {",
    '  const mongoose = (await import("mongoose")).default;',
    "  let raced = false;",
    "  mongoose.plugin((schema) => {",
    '    schema.post("findOne", async function (doc) {',
    '      if (raced || !doc || this.model?.modelName !== "Organization") return;',
    '      if (!Object.prototype.hasOwnProperty.call(this.getFilter(), "slug")) return;',
    "      raced = true;",
    `      const write = ${JSON.stringify(concurrentWrite)};`,
    "      if (write) await this.model.collection.updateOne({ _id: doc._id }, write);",
    `      console.error(${JSON.stringify(RACE_MARK)}, JSON.stringify(write));`,
    "    });",
    "  });",
    `  await import(${JSON.stringify(`./${SCRIPT}`)});`,
    "})().catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");
  return runTsx(["-e", wrapper], knobs, {});
}

/** The second writer's stderr lines — one per write it made. */
const raceMarksOf = (run: ScriptRun) => lines(run.stderr).filter((l) => l.startsWith(RACE_MARK));

async function runTsx(
  args: string[],
  knobs: Partial<Record<Knob, string>>,
  target: Target,
): Promise<ScriptRun> {
  const inMemoryUri = process.env.PAYOPS_IT_MONGO_URI ?? "";
  const ownDb = mongoose.connection.db?.databaseName ?? "";
  // The guard: only ever this file's database on the in-memory mongod.
  expect(inMemoryUri, "MONGODB_URI must be the in-memory server").toMatch(
    /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  );
  expect(ownDb, "MONGODB_DB must be this file's own database").toMatch(/^it-[0-9a-f]{8}$/);
  expect(ownDb).toBe(process.env.MONGODB_DB);
  if (target.uri !== undefined) {
    expect(target.uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/$/);
    expect(target.uri).not.toBe(inMemoryUri);
  }
  if (target.dbName !== undefined) {
    expect(target.dbName).toBe(`${ownDb}-bare`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete env[k];
  }
  for (const k of KNOBS) delete env[k];
  Object.assign(
    env,
    { MONGODB_URI: target.uri ?? inMemoryUri, MONGODB_DB: target.dbName ?? ownDb },
    knobs,
  );

  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "tsx", ...args],
      { cwd: process.cwd(), env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: !error ? 0 : typeof error.code === "number" ? error.code : -1,
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Date.now() - started,
        });
      },
    );
  });
}

const out = (run: ScriptRun) => `exit ${run.exitCode} after ${run.ms}ms\n${run.stdout}\n${run.stderr}`;

/** stdout as its lines, without the final newline. */
function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/** The script's report rows ("  • before         AUTOMATIC"), by label. */
function reportOf(stdout: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of lines(stdout)) {
    const m = /^ {2}• (organization|stored|before|after|gateways) +(.*)$/.exec(line);
    if (m) rows[m[1]!] = m[2]!;
  }
  return rows;
}

const FAILED = "set-organization-capture-mode failed: ";

/** The reason the script gave on stderr, or null when it gave none. */
function failureOf(run: ScriptRun): string | null {
  const hits = lines(run.stderr).filter((l) => l.startsWith(FAILED));
  expect(hits.length, run.stderr).toBeLessThanOrEqual(1);
  return hits[0]?.slice(FAILED.length) ?? null;
}

function expectSucceeded(run: ScriptRun) {
  expect(run.exitCode, out(run)).toBe(0);
  expect(failureOf(run), out(run)).toBeNull();
}

function expectRefused(run: ScriptRun, reason: string, stdout: string[]) {
  expect(run.exitCode, out(run)).toBe(1);
  expect(failureOf(run), out(run)).toBe(reason);
  expect(lines(run.stdout)).toEqual(stdout);
}

const settingLine = (slug: string, mode: string, apply: boolean) =>
  `→ Setting the capture mode of organization "${slug}" to ${mode}${
    apply ? "" : " (dry run — set APPLY=1 to write)"
  }`;

/** A free port on this machine: bound, read, released. */
async function unusedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ *
 * The database, as stored — raw driver, canonical Extended JSON
 * ------------------------------------------------------------------ */

type Db = NonNullable<typeof mongoose.connection.db>;
type Raw = Record<string, unknown>;

const { EJSON } = mongoose.mongo.BSON;

/** Every BSON type, every value, every key in stored order. */
const canonical = (doc: unknown): string => EJSON.stringify(doc, { relaxed: false });

function mainDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Not connected to this file's database");
  return db;
}

/** collection → (_id → canonical document), for every collection. */
type DbSnapshot = Record<string, Record<string, string>>;

async function snapshotDb(db: Db = mainDb()): Promise<DbSnapshot> {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((name) => !name.startsWith("system."))
    .sort();
  const snapshot: DbSnapshot = {};
  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    snapshot[name] = Object.fromEntries(docs.map((d) => [String(d._id), canonical(d)]));
  }
  return snapshot;
}

/** The seeded world's size — four organizations, one member each, sixteen
 *  orders, unless a test added to it — so "the same bytes" can never be the
 *  same nothing. */
function expectSeededWorld(
  snapshot: DbSnapshot,
  { organizations = 4, orders = 16 }: { organizations?: number; orders?: number } = {},
) {
  expect(Object.keys(snapshot.organizations ?? {})).toHaveLength(organizations);
  expect(Object.keys(snapshot.organization_members ?? {})).toHaveLength(4);
  expect(Object.keys(snapshot.orders ?? {})).toHaveLength(orders);
}

/** The snapshot with one document left out. */
function withoutDoc(snapshot: DbSnapshot, collection: string, id: Types.ObjectId): DbSnapshot {
  const docs = { ...snapshot[collection] };
  expect(docs, `${collection} ${String(id)} is not in the snapshot`).toHaveProperty(String(id));
  delete docs[String(id)];
  return { ...snapshot, [collection]: docs };
}

/** An organization exactly as stored. */
async function rawOrg(slug: string, db: Db = mainDb()): Promise<Raw> {
  const doc = await db.collection("organizations").findOne({ slug });
  expect(doc, `organization ${slug} is missing`).toBeTruthy();
  return doc as Raw;
}

/** The canonical document with `paths` (dotted) removed. */
function canonicalWithout(doc: Raw, paths: string[]): string {
  const copy = EJSON.parse(canonical(doc), { relaxed: false }) as Raw;
  for (const p of paths) {
    const keys = p.split(".");
    let node: unknown = copy;
    for (const k of keys.slice(0, -1)) {
      node = node && typeof node === "object" ? (node as Raw)[k] : undefined;
    }
    if (node && typeof node === "object") delete (node as Raw)[keys[keys.length - 1]!];
  }
  return canonical(copy);
}

const paymentsOf = (doc: Raw) => doc.payments as Raw;

/**
 * NARROW: between `before` and `after`, the one organization changed only
 * `payments.captureMode` (to `mode`) and `updatedAt` (moved forward), and
 * every other document of every collection is the same bytes.
 */
function expectOnlyCaptureModeWritten(
  snapshots: { before: DbSnapshot; after: DbSnapshot },
  docs: { before: Raw; after: Raw },
  orgId: Types.ObjectId,
  mode: CaptureMode,
) {
  expect(paymentsOf(docs.after).captureMode).toBe(mode);
  expect(canonicalWithout(docs.after, ["updatedAt", "payments.captureMode"])).toBe(
    canonicalWithout(docs.before, ["updatedAt", "payments.captureMode"]),
  );
  expect((docs.after.updatedAt as Date).getTime()).toBeGreaterThan(
    (docs.before.updatedAt as Date).getTime(),
  );
  expect(withoutDoc(snapshots.after, "organizations", orgId)).toEqual(
    withoutDoc(snapshots.before, "organizations", orgId),
  );
}

/* ------------------------------------------------------------------ */

beforeEach(async () => {
  await ensureMongo();
  // Let this process finish creating its own collections and indexes, so
  // nothing but the script can change the database between two snapshots.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  orgIds.rc = await makeRentalConfirmation();
  orgIds.trip = await makeTripReservations();
  orgIds.coast = await makeCoastalTrips();
  orgIds.gv = await makeGlobeVista();
  await seedOrders();
  // The first run builds every model's indexes on the in-memory database,
  // which can outlast the 60s default hook timeout on a loaded machine; later
  // runs find them in place (the shared setup empties collections, never
  // drops them).
}, 180_000);

describe("scripts/set-organization-capture-mode.ts — run for real against this file's database", () => {
  it("1. DRY RUN for the default organization (rentalconfirmation, CAPTURE_MODE=MANUAL, no APPLY): exit 0 and the full report — '(none stored — reads as AUTOMATIC)', before AUTOMATIC → after MANUAL, Stripe only, '2 not yet initiated' (one stored with no organization), '1 with an open charge-at-checkout link', the DEPLOYMENT endpoint <APP_URL>/api/webhooks/stripe (never /stripe/rentalconfirmation) with every event it needs, 'dry run: no writes made' — and every organization, every collection, the same bytes after", async () => {
    // The world, as stored: Rental is the default and stores no mode.
    const rcBefore = await rawOrg(RC.slug);
    expect(rcBefore.isDefault).toBe(true);
    expect(rcBefore).not.toHaveProperty("serviceTypes");
    expect(rcBefore).not.toHaveProperty("legal");
    expect(paymentsOf(rcBefore)).toMatchObject({ provider: "STRIPE", enabledProviders: ["STRIPE"] });
    expect(paymentsOf(rcBefore)).not.toHaveProperty("captureMode");
    // Rental's orders as stored: three carry its id, and the one order in
    // the world stored with organizationId null is a NOT_INITIATED one — so
    // "2 not yet initiated" below can only come from counting it as Rental's.
    expect(await Order.collection.countDocuments({ organizationId: orgIds.rc })).toBe(3);
    const unowned = await Order.collection.find({ organizationId: null }).toArray();
    expect(unowned).toHaveLength(1);
    expect(unowned[0]).toMatchObject({ organizationId: null, status: OrderStatus.NOT_INITIATED });
    // The module's list and path are the literal ones (the reference).
    expect([...MANUAL_CAPTURE_STRIPE_EVENTS]).toEqual(STRIPE_EVENTS);
    expect(stripeWebhookPath({ slug: RC.slug, isDefault: true })).toBe("/api/webhooks/stripe");
    // …and that is the route the deployment's Stripe events really reach.
    expect(existsSync(path.join(process.cwd(), "src/app/api/webhooks/stripe/route.ts"))).toBe(true);

    const orgsBefore = await Organization.collection.find({}).toArray();
    expect(orgsBefore.map((o) => o.slug).sort()).toEqual([...ALL_SLUGS].sort());
    const before = await snapshotDb();
    expectSeededWorld(before);

    const dry = await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL" });

    expectSucceeded(dry);
    expect(lines(dry.stdout)).toEqual([
      settingLine(RC.slug, "MANUAL", false),
      `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      "  • stored         (none stored — reads as AUTOMATIC)",
      "  • before         AUTOMATIC",
      "  • after          MANUAL",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 2 not yet initiated: their first payment link uses MANUAL",
      `    – 1 ${OPEN_LINK_NOTE}`,
      "    – paid orders: unchanged",
      ...webhookBlock("/api/webhooks/stripe"),
      "  • dry run: no writes made",
    ]);
    expect(dry.stdout).not.toContain("/api/webhooks/stripe/rentalconfirmation");
    expect(dry.stdout).not.toContain("✓ stored");
    // Every event the lifecycle needs, each on its own line.
    for (const event of STRIPE_EVENTS) expect(lines(dry.stdout)).toContain(`      ${event}`);

    // No write: every organization, and every other collection, the same bytes.
    const orgsAfter = await Organization.collection.find({}).toArray();
    expect(orgsAfter.map(canonical)).toEqual(orgsBefore.map(canonical));
    expect(await snapshotDb()).toEqual(before);
    expect(paymentsOf(await rawOrg(RC.slug))).not.toHaveProperty("captureMode");
  }, 180_000);

  it("1b. APPLY MEANS EXACTLY \"1\" (\"Anything else = dry run\"): APPLY=true and APPLY=0 for rentalconfirmation → MANUAL each print the dry-run banner and the whole dry-run report ending 'dry run: no writes made' — no '✓ stored' — and the database stays the same bytes", async () => {
    const before = await snapshotDb();
    expectSeededWorld(before);

    for (const apply of ["true", "0"]) {
      const run = await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: apply });

      expectSucceeded(run);
      expect(lines(run.stdout), `APPLY=${apply}`).toEqual([
        settingLine(RC.slug, "MANUAL", false),
        `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
        "  • stored         (none stored — reads as AUTOMATIC)",
        "  • before         AUTOMATIC",
        "  • after          MANUAL",
        "  • gateways       STRIPE",
        "  • existing orders:",
        "    – 2 not yet initiated: their first payment link uses MANUAL",
        `    – 1 ${OPEN_LINK_NOTE}`,
        "    – paid orders: unchanged",
        ...webhookBlock("/api/webhooks/stripe"),
        "  • dry run: no writes made",
      ]);
      expect(run.stdout).not.toContain("✓ stored");
      expect(await snapshotDb(), `APPLY=${apply} wrote`).toEqual(before);
    }
    expect(paymentsOf(await rawOrg(RC.slug))).not.toHaveProperty("captureMode");
  }, 180_000);

  it("2. APPLY=1 for rentalconfirmation: exit 0, '✓ stored MANUAL' then '✔ Organization capture mode updated.'; the raw diff is ONLY payments.captureMode = \"MANUAL\" (appended to the stored payments object) and a later updatedAt on that one document — every other organization and every other collection (orders, members) the same bytes", async () => {
    const rcBefore = await rawOrg(RC.slug);
    expect(paymentsOf(rcBefore)).not.toHaveProperty("captureMode");
    const before = await snapshotDb();
    expectSeededWorld(before);

    const applied = await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" });

    expectSucceeded(applied);
    const printed = lines(applied.stdout);
    expect(printed[0]).toBe(settingLine(RC.slug, "MANUAL", true));
    expect(reportOf(applied.stdout)).toEqual({
      organization: `Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      stored: "(none stored — reads as AUTOMATIC)",
      before: "AUTOMATIC",
      after: "MANUAL",
      gateways: "STRIPE",
    });
    expect(printed).toContain(webhookBlock("/api/webhooks/stripe")[0]);
    expect(printed).not.toContain("  • dry run: no writes made");
    expect(printed).not.toContain("  • nothing to change: no writes made");
    expect(printed.slice(-2)).toEqual(["  ✓ stored MANUAL", "✔ Organization capture mode updated."]);

    const rcAfter = await rawOrg(RC.slug);
    expectOnlyCaptureModeWritten(
      { before, after: await snapshotDb() },
      { before: rcBefore, after: rcAfter },
      orgIds.rc,
      CaptureMode.MANUAL,
    );
    // `$set` appended exactly one key to the payments object it found.
    expect(Object.keys(paymentsOf(rcAfter))).toEqual([
      ...Object.keys(paymentsOf(rcBefore)),
      "captureMode",
    ]);
    // Nothing else of Rental's: still no service list or legal stored.
    expect(rcAfter).not.toHaveProperty("serviceTypes");
    expect(rcAfter).not.toHaveProperty("legal");
  }, 180_000);

  it("2b. NARROW AT THE CONNECTION: against a database holding only the organizations, orders and members — none of the app's indexes, none of its other collections, as in production (autoIndex:false) — APPLY=1 still stores MANUAL, yet creates no collection and builds no index (while the app's own connectMongo(), the control, does both there); this file's own database is untouched by that run", async () => {
    const main = mainDb();
    const bareName = `${main.databaseName}-bare`;
    const bare = mongoose.connection.getClient().db(bareName);
    await bare.dropDatabase();
    try {
      for (const name of ["organizations", "orders", "organization_members"]) {
        const docs = await main.collection(name).find({}).toArray();
        expect(docs.length, name).toBeGreaterThan(0);
        await bare.collection(name).insertMany(docs);
      }
      const shape = async () => {
        const names = (await bare.listCollections({}, { nameOnly: true }).toArray())
          .map((c) => c.name)
          .sort();
        const indexes: Record<string, string[]> = {};
        for (const name of names) {
          indexes[name] = (await bare.collection(name).indexes()).map((i) => String(i.name)).sort();
        }
        return indexes;
      };
      const bareShape = {
        orders: ["_id_"],
        organization_members: ["_id_"],
        organizations: ["_id_"],
      };
      expect(await shape()).toEqual(bareShape);
      const rcBefore = await rawOrg(RC.slug, bare);
      const bareBefore = await snapshotDb(bare);
      expectSeededWorld(bareBefore);
      expect(Object.keys(bareBefore).sort()).toEqual(Object.keys(bareShape).sort());
      const mainBefore = await snapshotDb();
      expectSeededWorld(mainBefore);

      const applied = await runCaptureModeScript(
        { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" },
        { dbName: bareName },
      );

      expectSucceeded(applied);
      expect(lines(applied.stdout).slice(-2)).toEqual([
        "  ✓ stored MANUAL",
        "✔ Organization capture mode updated.",
      ]);
      expect(lines(applied.stdout)).toContain("    – 2 not yet initiated: their first payment link uses MANUAL");
      // No collection created, no index built.
      expect(await shape()).toEqual(bareShape);
      // The one field, in the database it was pointed at…
      expectOnlyCaptureModeWritten(
        { before: bareBefore, after: await snapshotDb(bare) },
        { before: rcBefore, after: await rawOrg(RC.slug, bare) },
        orgIds.rc,
        CaptureMode.MANUAL,
      );
      // …and nowhere else.
      expect(await snapshotDb()).toEqual(mainBefore);

      // The control: the app's own connection, pointed at the same
      // database, DOES create the models' collections and build their
      // indexes — so the unchanged shape above is the script's doing.
      const control = await runAppConnection({ dbName: bareName });
      expect(control.exitCode, out(control)).toBe(0);
      const connected = await shape();
      expect(Object.keys(connected)).toEqual(
        expect.arrayContaining(["audit_logs", "orders", "organizations", "settings", "users"]),
      );
      expect(connected.organizations).toEqual(expect.arrayContaining(["_id_", "isDefault_1", "slug_1"]));
      expect(connected.orders!.length).toBeGreaterThan(1);
    } finally {
      await bare.dropDatabase();
    }
  }, 180_000);

  it("3. IDEMPOTENT: after APPLY=1, a second APPLY=1 reads stored MANUAL, before MANUAL → after MANUAL, prints 'nothing to change: no writes made' (no '✓ stored') and leaves the database the same bytes, updatedAt included; asking for AUTOMATIC where nothing is stored (tripreservations) is likewise 'nothing to change' — no explicit AUTOMATIC is written", async () => {
    expectSucceeded(await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" }));
    const stored = await rawOrg(RC.slug);
    expect(paymentsOf(stored).captureMode).toBe("MANUAL");
    const before = await snapshotDb();
    expectSeededWorld(before);

    const again = await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" });

    expectSucceeded(again);
    expect(lines(again.stdout)).toEqual([
      settingLine(RC.slug, "MANUAL", true),
      `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      "  • stored         MANUAL",
      "  • before         MANUAL",
      "  • after          MANUAL",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 2 not yet initiated: their first payment link uses MANUAL",
      `    – 1 ${OPEN_LINK_NOTE}`,
      "    – paid orders: unchanged",
      ...webhookBlock("/api/webhooks/stripe"),
      "  • nothing to change: no writes made",
    ]);
    expect(await snapshotDb()).toEqual(before);
    expect(canonical(await rawOrg(RC.slug))).toBe(canonical(stored));

    // AUTOMATIC where nothing is stored: already AUTOMATIC, nothing written.
    const tripBefore = await rawOrg(TRIP.slug);
    expect(paymentsOf(tripBefore)).not.toHaveProperty("captureMode");
    const automatic = await runCaptureModeScript({
      ORG_SLUG: TRIP.slug,
      CAPTURE_MODE: "AUTOMATIC",
      APPLY: "1",
    });
    expectSucceeded(automatic);
    expect(reportOf(automatic.stdout)).toMatchObject({
      stored: "(none stored — reads as AUTOMATIC)",
      before: "AUTOMATIC",
      after: "AUTOMATIC",
    });
    expect(lines(automatic.stdout).at(-1)).toBe("  • nothing to change: no writes made");
    expect(automatic.stdout).not.toContain("Stripe webhook endpoint");
    expect(automatic.stdout).not.toContain("✓ stored");
    expect(await snapshotDb()).toEqual(before);
    expect(paymentsOf(await rawOrg(TRIP.slug))).not.toHaveProperty("captureMode");
  }, 180_000);

  it("4. ORDER COUNTS for the default organization once it runs MANUAL: its live holds — its own AUTHORIZED, a CAPTURE_FAILED stored with organizationId null, a PENDING_AUTHORIZATION stored with no organizationId key at all — are '3 still on the manual lifecycle' when it switches back (not its CAPTURED order, not one already PAID while its capture still reads CAPTURE_PENDING, not GlobeVista's four live holds), with '2 not yet initiated'; none of those manual orders is an open charge-at-checkout link (still '1'); without ALLOW_AUTOMATIC the switch back is refused, with it the dry run writes nothing", async () => {
    expectSucceeded(await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" }));
    // Rental's orders on the manual lifecycle once it runs MANUAL.
    await seedOrder(orgIds.rc, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.AUTHORIZED);
    await seedOrder(null, OrderStatus.PAYMENT_PENDING, PaymentCaptureStatus.CAPTURE_FAILED);
    const legacy = await seedOrder(null, OrderStatus.LINK_GENERATED, PaymentCaptureStatus.PENDING_AUTHORIZATION);
    await Order.collection.updateOne({ _id: legacy }, { $unset: { organizationId: "" } });
    expect(await Order.collection.findOne({ _id: legacy })).not.toHaveProperty("organizationId");
    await seedOrder(orgIds.rc, OrderStatus.PAID, PaymentCaptureStatus.CAPTURED);
    // Paid by payment_intent.succeeded, whose capture bookkeeping (a second,
    // separate write in webhook.service) has not landed: the money is taken,
    // so it is no live hold — the count excludes it by its PAID status alone.
    const paidMidCapture = await seedOrder(orgIds.rc, OrderStatus.PAID, PaymentCaptureStatus.CAPTURE_PENDING);
    const paidMidCaptureRaw = await Order.collection.findOne({ _id: paidMidCapture });
    expect(String(paidMidCaptureRaw?.organizationId)).toBe(String(orgIds.rc));
    expect(paidMidCaptureRaw).toMatchObject({
      status: OrderStatus.PAID,
      payment: { capture: { method: CaptureMode.MANUAL, status: PaymentCaptureStatus.CAPTURE_PENDING } },
    });
    const before = await snapshotDb();
    expectSeededWorld(before, { orders: 21 });

    // Still MANUAL: three of those manual orders sit in LINK_GENERATED /
    // PAYMENT_PENDING, yet none is an open charge-at-checkout link — the
    // count stays at Rental's one LINK_GENERATED order with no capture.
    const manual = await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL" });
    expectSucceeded(manual);
    expect(lines(manual.stdout)).toEqual([
      settingLine(RC.slug, "MANUAL", false),
      `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      "  • stored         MANUAL",
      "  • before         MANUAL",
      "  • after          MANUAL",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 2 not yet initiated: their first payment link uses MANUAL",
      `    – 1 ${OPEN_LINK_NOTE}`,
      "    – paid orders: unchanged",
      ...webhookBlock("/api/webhooks/stripe"),
      "  • nothing to change: no writes made",
    ]);
    expect(await snapshotDb()).toEqual(before);

    // Unconfirmed: refused, dry run or not.
    for (const apply of [false, true]) {
      const refused = await runCaptureModeScript({
        ORG_SLUG: RC.slug,
        CAPTURE_MODE: "AUTOMATIC",
        ...(apply ? { APPLY: "1" } : {}),
      });
      expectRefused(refused, SWITCH_BACK_REFUSAL, [settingLine(RC.slug, "AUTOMATIC", apply)]);
    }

    const dry = await runCaptureModeScript({
      ORG_SLUG: RC.slug,
      CAPTURE_MODE: "AUTOMATIC",
      ALLOW_AUTOMATIC: "1",
    });
    expectSucceeded(dry);
    expect(lines(dry.stdout)).toEqual([
      settingLine(RC.slug, "AUTOMATIC", false),
      `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      "  • stored         MANUAL",
      "  • before         MANUAL",
      "  • after          AUTOMATIC",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 2 not yet initiated: their first payment link uses AUTOMATIC",
      `    – 3 ${LIVE_MANUAL_NOTE}`,
      "    – paid orders: unchanged",
      "  • dry run: no writes made",
    ]);
    expect(await snapshotDb()).toEqual(before);
  }, 180_000);

  it("5. TRIPRESERVATIONS → MANUAL (ORG_SLUG ' TripReservations ', CAPTURE_MODE ' manual ' — trimmed and case-folded), APPLY=1: allowed; gateways PAYPAL, STRIPE with 'PAYPAL links keep charging at checkout: manual capture is Stripe-only'; ITS OWN endpoint <APP_URL>/api/webhooks/stripe/tripreservations; counts only its own orders; only its payments.captureMode and updatedAt written", async () => {
    const tripBefore = await rawOrg(TRIP.slug);
    expect(tripBefore.isDefault).toBe(false);
    expect(paymentsOf(tripBefore)).toMatchObject({
      provider: "PAYPAL",
      enabledProviders: ["PAYPAL", "STRIPE"],
    });
    expect(paymentsOf(tripBefore)).not.toHaveProperty("captureMode");
    expect(stripeWebhookPath({ slug: TRIP.slug, isDefault: false })).toBe(
      "/api/webhooks/stripe/tripreservations",
    );
    expect(
      existsSync(path.join(process.cwd(), "src/app/api/webhooks/stripe/[orgSlug]/route.ts")),
    ).toBe(true);
    const before = await snapshotDb();
    expectSeededWorld(before);

    const applied = await runCaptureModeScript({
      ORG_SLUG: " TripReservations ",
      CAPTURE_MODE: " manual ",
      APPLY: "1",
    });

    expectSucceeded(applied);
    expect(lines(applied.stdout)).toEqual([
      settingLine(TRIP.slug, "MANUAL", true),
      `  • organization   Trip Reservations (tripreservations, ${String(orgIds.trip)}, ACTIVE)`,
      "  • stored         (none stored — reads as AUTOMATIC)",
      "  • before         AUTOMATIC",
      "  • after          MANUAL",
      "  • gateways       PAYPAL, STRIPE",
      "    – PAYPAL links keep charging at checkout: manual capture is Stripe-only",
      "  • existing orders:",
      "    – 1 not yet initiated: their first payment link uses MANUAL",
      `    – 1 ${OPEN_LINK_NOTE}`,
      "    – paid orders: unchanged",
      ...webhookBlock("/api/webhooks/stripe/tripreservations"),
      "  ✓ stored MANUAL",
      "✔ Organization capture mode updated.",
    ]);
    expectOnlyCaptureModeWritten(
      { before, after: await snapshotDb() },
      { before: tripBefore, after: await rawOrg(TRIP.slug) },
      orgIds.trip,
      CaptureMode.MANUAL,
    );
    // PayPal stays the default gateway: nothing about the gateways moved.
    expect(paymentsOf(await rawOrg(TRIP.slug))).toMatchObject({
      provider: "PAYPAL",
      enabledProviders: ["PAYPAL", "STRIPE"],
    });
  }, 180_000);

  it("6a. REFUSED INPUTS, before the database is reached (nothing printed on stdout, not even the '→ Setting…' line that precedes the connection): no ORG_SLUG, a blank ORG_SLUG, no CAPTURE_MODE, a blank CAPTURE_MODE, CAPTURE_MODE=MANUL — each exit 1 with its reason on stderr, the database the same bytes", async () => {
    const before = await snapshotDb();
    expectSeededWorld(before);
    const cases: Array<{ knobs: Partial<Record<Knob, string>>; reason: string }> = [
      { knobs: { CAPTURE_MODE: "MANUAL", APPLY: "1" }, reason: "Set ORG_SLUG to the organization's slug." },
      { knobs: { ORG_SLUG: "   ", CAPTURE_MODE: "MANUAL", APPLY: "1" }, reason: "Set ORG_SLUG to the organization's slug." },
      { knobs: { ORG_SLUG: RC.slug, APPLY: "1" }, reason: "Set CAPTURE_MODE to AUTOMATIC or MANUAL." },
      { knobs: { ORG_SLUG: RC.slug, CAPTURE_MODE: "  ", APPLY: "1" }, reason: "Set CAPTURE_MODE to AUTOMATIC or MANUAL." },
      {
        knobs: { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUL", APPLY: "1" },
        reason: "Unknown capture mode: MANUL. Use AUTOMATIC or MANUAL.",
      },
    ];
    for (const { knobs, reason } of cases) {
      expectRefused(await runCaptureModeScript(knobs), reason, []);
    }
    expect(await snapshotDb()).toEqual(before);
    expect(paymentsOf(await rawOrg(RC.slug))).not.toHaveProperty("captureMode");
  }, 180_000);

  it("6b. CAPTURE_MODE IS CHECKED BEFORE ANY CONNECTION: pointed at a MongoDB port nothing listens on, CAPTURE_MODE=MANUL still comes back as the parse refusal (exit 1, nothing on stdout) — while the control, a valid CAPTURE_MODE against the same address, prints '→ Setting…' and then fails on the connection itself", async () => {
    const port = await unusedLocalPort();
    expect(port).toBeGreaterThan(0);
    const unreachable = `mongodb://127.0.0.1:${port}/`;

    const refused = await runCaptureModeScript(
      { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUL", APPLY: "1" },
      { uri: unreachable },
    );
    expectRefused(refused, "Unknown capture mode: MANUL. Use AUTOMATIC or MANUAL.", []);

    // The control: the same address really is unreachable, and a script
    // that got past parsing would have failed on it — differently.
    const control = await runCaptureModeScript(
      { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL" },
      { uri: unreachable },
    );
    expect(control.exitCode, out(control)).toBe(1);
    expect(lines(control.stdout)).toEqual([settingLine(RC.slug, "MANUAL", false)]);
    const reason = failureOf(control) ?? "";
    expect(reason, out(control)).toContain(`127.0.0.1:${port}`);
    expect(reason).not.toContain("capture mode");
  }, 180_000);

  it("6c. AN UNKNOWN SLUG is refused with every known slug listed (exit 1); nothing is written", async () => {
    const before = await snapshotDb();
    expectSeededWorld(before);
    const run = await runCaptureModeScript({ ORG_SLUG: "nosuchbrand", CAPTURE_MODE: "MANUAL", APPLY: "1" });
    expect(run.exitCode, out(run)).toBe(1);
    expect(lines(run.stdout)).toEqual([settingLine("nosuchbrand", "MANUAL", true)]);
    const reason = failureOf(run) ?? "";
    const m = /^No organization with slug "nosuchbrand"\. Known slugs: (.+)\.$/.exec(reason);
    expect(m, out(run)).not.toBeNull();
    expect(m![1]!.split(", ").sort()).toEqual([...ALL_SLUGS].sort());
    expect(await snapshotDb()).toEqual(before);
  }, 180_000);

  it("6d. MANUAL FOR THE PAYPAL-ONLY BRAND (coastaltrips) is refused — it takes no Stripe payments, so MANUAL would change nothing — and nothing is written; AUTOMATIC for it is accepted as 'nothing to change'", async () => {
    const before = await snapshotDb();
    expectSeededWorld(before);
    const coastBefore = await rawOrg(COAST.slug);
    expect(paymentsOf(coastBefore)).toMatchObject({ provider: "PAYPAL", enabledProviders: ["PAYPAL"] });

    const manual = await runCaptureModeScript({ ORG_SLUG: COAST.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" });
    expectRefused(
      manual,
      "This organization does not take Stripe payments (enabled: PAYPAL). Manual capture applies to Stripe only, so MANUAL would change nothing.",
      [settingLine(COAST.slug, "MANUAL", true)],
    );
    expect(await snapshotDb()).toEqual(before);

    const automatic = await runCaptureModeScript({ ORG_SLUG: COAST.slug, CAPTURE_MODE: "AUTOMATIC", APPLY: "1" });
    expectSucceeded(automatic);
    expect(reportOf(automatic.stdout)).toMatchObject({
      before: "AUTOMATIC",
      after: "AUTOMATIC",
      gateways: "PAYPAL",
    });
    expect(lines(automatic.stdout).at(-1)).toBe("  • nothing to change: no writes made");
    expect(await snapshotDb()).toEqual(before);
  }, 180_000);

  it("6e. MANUAL → AUTOMATIC FOR GLOBEVISTA: refused without ALLOW_AUTOMATIC (dry run and APPLY=1 alike, the reason naming ALLOW_AUTOMATIC=1) and with ALLOW_AUTOMATIC=true (only \"1\" confirms); with ALLOW_AUTOMATIC=1 the dry run reports '1 not yet initiated' and '4 still on the manual lifecycle' and writes nothing; with ALLOW_AUTOMATIC=1 APPLY=1 it stores AUTOMATIC — only payments.captureMode and updatedAt change", async () => {
    const gvBefore = await rawOrg(GV.slug);
    expect(paymentsOf(gvBefore).captureMode).toBe("MANUAL");
    const before = await snapshotDb();
    expectSeededWorld(before);

    const unconfirmed: Array<Partial<Record<Knob, string>>> = [
      {},
      { APPLY: "1" },
      // "true" is not "1": no confirmation, even with APPLY=1.
      { ALLOW_AUTOMATIC: "true", APPLY: "1" },
    ];
    for (const knobs of unconfirmed) {
      const refused = await runCaptureModeScript({ ORG_SLUG: GV.slug, CAPTURE_MODE: "AUTOMATIC", ...knobs });
      expectRefused(refused, SWITCH_BACK_REFUSAL, [settingLine(GV.slug, "AUTOMATIC", knobs.APPLY === "1")]);
      expect(failureOf(refused)).toContain("ALLOW_AUTOMATIC=1");
    }
    expect(await snapshotDb()).toEqual(before);

    const dry = await runCaptureModeScript({
      ORG_SLUG: GV.slug,
      CAPTURE_MODE: "AUTOMATIC",
      ALLOW_AUTOMATIC: "1",
    });
    expectSucceeded(dry);
    expect(lines(dry.stdout)).toEqual([
      settingLine(GV.slug, "AUTOMATIC", false),
      `  • organization   FlightBizz (globevista, ${String(orgIds.gv)}, ACTIVE)`,
      "  • stored         MANUAL",
      "  • before         MANUAL",
      "  • after          AUTOMATIC",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 1 not yet initiated: their first payment link uses AUTOMATIC",
      `    – 4 ${LIVE_MANUAL_NOTE}`,
      "    – paid orders: unchanged",
      "  • dry run: no writes made",
    ]);
    expect(await snapshotDb()).toEqual(before);

    const applied = await runCaptureModeScript({
      ORG_SLUG: GV.slug,
      CAPTURE_MODE: "AUTOMATIC",
      ALLOW_AUTOMATIC: "1",
      APPLY: "1",
    });
    expectSucceeded(applied);
    expect(lines(applied.stdout).slice(-2)).toEqual([
      "  ✓ stored AUTOMATIC",
      "✔ Organization capture mode updated.",
    ]);
    const gvAfter = await rawOrg(GV.slug);
    expectOnlyCaptureModeWritten(
      { before, after: await snapshotDb() },
      { before: gvBefore, after: gvAfter },
      orgIds.gv,
      CaptureMode.AUTOMATIC,
    );
    // Updated in place: the payments object keeps its keys, in order.
    expect(Object.keys(paymentsOf(gvAfter))).toEqual(Object.keys(paymentsOf(gvBefore)));
  }, 180_000);

  it("6f. STORED STATE IT WILL NOT WRITE THROUGH: a stored captureMode \"BOGUS\" (written raw — the model refuses it) is refused for MANUAL and for a confirmed AUTOMATIC alike, and stays stored; an organization whose payments is null is refused; while an explicitly stored null captureMode reads as '(none stored — reads as AUTOMATIC)' and IS replaced — only that field and updatedAt", async () => {
    // The model's own write path refuses the value; only a raw write stores it.
    await expect(
      Organization.updateOne(
        { _id: orgIds.rc },
        { $set: { "payments.captureMode": "BOGUS" } },
        { runValidators: true },
      ),
    ).rejects.toThrow(/BOGUS/);
    await Organization.collection.updateOne(
      { _id: orgIds.rc },
      { $set: { "payments.captureMode": "BOGUS" } },
    );
    const bogus = await snapshotDb();
    expectSeededWorld(bogus);
    for (const knobs of [
      { CAPTURE_MODE: "MANUAL" },
      { CAPTURE_MODE: "AUTOMATIC", ALLOW_AUTOMATIC: "1" },
    ]) {
      const refused = await runCaptureModeScript({ ORG_SLUG: RC.slug, APPLY: "1", ...knobs });
      expectRefused(
        refused,
        'The stored capture mode "BOGUS" is not AUTOMATIC or MANUAL — refusing to overwrite it.',
        [settingLine(RC.slug, knobs.CAPTURE_MODE, true)],
      );
    }
    expect(await snapshotDb()).toEqual(bogus);
    expect(paymentsOf(await rawOrg(RC.slug)).captureMode).toBe("BOGUS");

    // A null payments object.
    const legacy = await Organization.create({
      slug: "legacy-brand",
      name: "Legacy Brand",
      brandName: "Legacy Brand",
      isDefault: false,
    });
    await Organization.collection.updateOne({ _id: legacy._id }, { $set: { payments: null } });
    expect((await rawOrg("legacy-brand")).payments).toBeNull();
    const nullPayments = await snapshotDb();
    expectSeededWorld(nullPayments, { organizations: 5 });
    const refused = await runCaptureModeScript({ ORG_SLUG: "legacy-brand", CAPTURE_MODE: "MANUAL", APPLY: "1" });
    expectRefused(
      refused,
      'Organization "legacy-brand" stores no payments settings object — refusing to write.',
      [settingLine("legacy-brand", "MANUAL", true)],
    );
    expect(await snapshotDb()).toEqual(nullPayments);

    // An explicit null is "none stored": read as AUTOMATIC and replaced.
    await Organization.collection.updateOne(
      { _id: orgIds.trip },
      { $set: { "payments.captureMode": null } },
    );
    const tripBefore = await rawOrg(TRIP.slug);
    expect(paymentsOf(tripBefore).captureMode).toBeNull();
    const before = await snapshotDb();
    expectSeededWorld(before, { organizations: 5 });
    const applied = await runCaptureModeScript({ ORG_SLUG: TRIP.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" });
    expectSucceeded(applied);
    expect(reportOf(applied.stdout)).toMatchObject({
      stored: "(none stored — reads as AUTOMATIC)",
      before: "AUTOMATIC",
      after: "MANUAL",
    });
    expect(lines(applied.stdout).slice(-2)).toEqual([
      "  ✓ stored MANUAL",
      "✔ Organization capture mode updated.",
    ]);
    const tripAfter = await rawOrg(TRIP.slug);
    expectOnlyCaptureModeWritten(
      { before, after: await snapshotDb() },
      { before: tripBefore, after: tripAfter },
      orgIds.trip,
      CaptureMode.MANUAL,
    );
    expect(Object.keys(paymentsOf(tripAfter))).toEqual(Object.keys(paymentsOf(tripBefore)));
  }, 180_000);

  it("7. THE APP HONOURS THE WRITE (same process, no cache): getOrganizationCaptureMode reads AUTOMATIC for Rental's id and for a null / empty organization before; after APPLY=1 for Rental and TripReservations it reads MANUAL for Rental's id, for null and \"\" (the default organization's decision) and for TripReservations' id, while Coastal Trips stays AUTOMATIC and GlobeVista MANUAL; null follows the isDefault flag, not the name; switching Rental back (ALLOW_AUTOMATIC=1 APPLY=1) takes null back to AUTOMATIC with it", async () => {
    const mode = (id: string | null) => getOrganizationCaptureMode(id);

    // BEFORE — the reference, absolute.
    expect(await mode(String(orgIds.rc))).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await mode("")).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(String(orgIds.trip))).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(String(orgIds.coast))).toBe(CaptureMode.AUTOMATIC);
    // A stored MANUAL reads as MANUAL: the reader is not a constant — and a
    // MANUAL organization that is not the default never decides for null.
    expect(await mode(String(orgIds.gv))).toBe(CaptureMode.MANUAL);

    expectSucceeded(await runCaptureModeScript({ ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" }));
    expectSucceeded(await runCaptureModeScript({ ORG_SLUG: TRIP.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" }));

    expect(await mode(String(orgIds.rc))).toBe(CaptureMode.MANUAL);
    expect(await mode(null)).toBe(CaptureMode.MANUAL);
    expect(await mode("")).toBe(CaptureMode.MANUAL);
    expect(await mode(String(orgIds.trip))).toBe(CaptureMode.MANUAL);
    expect(await mode(String(orgIds.gv))).toBe(CaptureMode.MANUAL);
    expect(await mode(String(orgIds.coast))).toBe(CaptureMode.AUTOMATIC);
    // Not an id (a slug), and an id of no organization: AUTOMATIC.
    expect(await mode(RC.slug)).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(new Types.ObjectId().toHexString())).toBe(CaptureMode.AUTOMATIC);

    // null is decided by whichever organization is the DEFAULT — with none,
    // it is AUTOMATIC even though Rental itself is MANUAL.
    await Organization.collection.updateOne({ _id: orgIds.rc }, { $set: { isDefault: false } });
    expect(await mode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(String(orgIds.rc))).toBe(CaptureMode.MANUAL);
    await Organization.collection.updateOne({ _id: orgIds.rc }, { $set: { isDefault: true } });
    expect(await mode(null)).toBe(CaptureMode.MANUAL);

    // Switch Rental back: its organization-less orders follow it.
    expectSucceeded(
      await runCaptureModeScript({
        ORG_SLUG: RC.slug,
        CAPTURE_MODE: "AUTOMATIC",
        ALLOW_AUTOMATIC: "1",
        APPLY: "1",
      }),
    );
    expect(paymentsOf(await rawOrg(RC.slug)).captureMode).toBe("AUTOMATIC");
    expect(await mode(String(orgIds.rc))).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(null)).toBe(CaptureMode.AUTOMATIC);
    expect(await mode(String(orgIds.trip))).toBe(CaptureMode.MANUAL);
    expect(await mode(String(orgIds.gv))).toBe(CaptureMode.MANUAL);
  }, 180_000);

  it("8. GUARDED: a mode changed between the script's read and its write aborts the write — exit 1, 'The organization's capture mode changed while this ran — nothing was written. Re-run to see the current value.', the full report but no '✓ stored', the other writer's value kept and updatedAt untouched — for a mode read as none stored (Rental → MANUAL while an explicit AUTOMATIC lands) and for a stored one (GlobeVista MANUAL → AUTOMATIC while the mode is removed); the control, the same wrapper writing nothing, applies normally", async () => {
    const CHANGED =
      "The organization's capture mode changed while this ran — nothing was written. Re-run to see the current value.";
    const rentalReport = (apply: boolean) => [
      settingLine(RC.slug, "MANUAL", apply),
      `  • organization   Rental Confirmation (rentalconfirmation, ${String(orgIds.rc)}, ACTIVE, default)`,
      "  • stored         (none stored — reads as AUTOMATIC)",
      "  • before         AUTOMATIC",
      "  • after          MANUAL",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 2 not yet initiated: their first payment link uses MANUAL",
      `    – 1 ${OPEN_LINK_NOTE}`,
      "    – paid orders: unchanged",
      ...webhookBlock("/api/webhooks/stripe"),
    ];

    // THE CONTROL: the wrapper, writing nothing, runs the script unchanged —
    // its hook fired once, at the read, and the write went through.
    const rcStart = await rawOrg(RC.slug);
    const start = await snapshotDb();
    expectSeededWorld(start);
    const control = await runWithConcurrentWrite(
      { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" },
      null,
    );
    expectSucceeded(control);
    expect(raceMarksOf(control)).toEqual([`${RACE_MARK} null`]);
    expect(lines(control.stdout)).toEqual([
      ...rentalReport(true),
      "  ✓ stored MANUAL",
      "✔ Organization capture mode updated.",
    ]);
    expectOnlyCaptureModeWritten(
      { before: start, after: await snapshotDb() },
      { before: rcStart, after: await rawOrg(RC.slug) },
      orgIds.rc,
      CaptureMode.MANUAL,
    );

    // Back to none stored, as production has it.
    await unsetRaw(orgIds.rc, ["payments.captureMode"]);
    const rcBefore = await rawOrg(RC.slug);
    expect(paymentsOf(rcBefore)).not.toHaveProperty("captureMode");
    const before = await snapshotDb();
    expectSeededWorld(before);

    // NONE STORED, read; an explicit AUTOMATIC lands before the write: the
    // "absent or null" guard matches nothing, and MANUAL is not written over it.
    const autoWrite = { $set: { "payments.captureMode": CaptureMode.AUTOMATIC } };
    const raced = await runWithConcurrentWrite(
      { ORG_SLUG: RC.slug, CAPTURE_MODE: "MANUAL", APPLY: "1" },
      autoWrite,
    );
    expectRefused(raced, CHANGED, rentalReport(true));
    expect(raceMarksOf(raced)).toEqual([`${RACE_MARK} ${JSON.stringify(autoWrite)}`]);
    const rcAfter = await rawOrg(RC.slug);
    expect(paymentsOf(rcAfter).captureMode).toBe("AUTOMATIC");
    // Only the other writer's field differs — updatedAt included: the script
    // wrote nothing at all.
    expect(canonicalWithout(rcAfter, ["payments.captureMode"])).toBe(
      canonicalWithout(rcBefore, ["payments.captureMode"]),
    );
    expect((rcAfter.updatedAt as Date).getTime()).toBe((rcBefore.updatedAt as Date).getTime());
    expect(withoutDoc(await snapshotDb(), "organizations", orgIds.rc)).toEqual(
      withoutDoc(before, "organizations", orgIds.rc),
    );

    // A STORED MODE, read (GlobeVista's MANUAL); the mode is removed before
    // the write: the "still MANUAL" guard matches nothing, and AUTOMATIC is
    // not written in its place.
    const gvBefore = await rawOrg(GV.slug);
    expect(paymentsOf(gvBefore).captureMode).toBe("MANUAL");
    const beforeGv = await snapshotDb();
    expectSeededWorld(beforeGv);
    const removeWrite = { $unset: { "payments.captureMode": "" } };
    const racedGv = await runWithConcurrentWrite(
      { ORG_SLUG: GV.slug, CAPTURE_MODE: "AUTOMATIC", ALLOW_AUTOMATIC: "1", APPLY: "1" },
      removeWrite,
    );
    expectRefused(racedGv, CHANGED, [
      settingLine(GV.slug, "AUTOMATIC", true),
      `  • organization   FlightBizz (globevista, ${String(orgIds.gv)}, ACTIVE)`,
      "  • stored         MANUAL",
      "  • before         MANUAL",
      "  • after          AUTOMATIC",
      "  • gateways       STRIPE",
      "  • existing orders:",
      "    – 1 not yet initiated: their first payment link uses AUTOMATIC",
      `    – 4 ${LIVE_MANUAL_NOTE}`,
      "    – paid orders: unchanged",
    ]);
    expect(raceMarksOf(racedGv)).toEqual([`${RACE_MARK} ${JSON.stringify(removeWrite)}`]);
    const gvAfter = await rawOrg(GV.slug);
    expect(paymentsOf(gvAfter)).not.toHaveProperty("captureMode");
    expect(canonicalWithout(gvAfter, ["payments.captureMode"])).toBe(
      canonicalWithout(gvBefore, ["payments.captureMode"]),
    );
    expect(withoutDoc(await snapshotDb(), "organizations", orgIds.gv)).toEqual(
      withoutDoc(beforeGv, "organizations", orgIds.gv),
    );
  }, 180_000);
});
