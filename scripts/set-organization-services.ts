/**
 * Enable — or, deliberately, disable — the services an organization sells
 * (car rental, flights, hotel stays).
 *
 * Run (reports only, writes nothing):
 *   ORG_SLUG=tripreservations SERVICES=FLIGHT,HOTEL \
 *     npx tsx --env-file=.env.payops.local scripts/set-organization-services.ts
 *
 * Apply for real:
 *   APPLY=1 ORG_SLUG=tripreservations SERVICES=FLIGHT,HOTEL \
 *     npx tsx --env-file=.env.payops.local scripts/set-organization-services.ts
 *
 * Knobs (env vars):
 *   ORG_SLUG      the organization's slug. Required; an unknown slug is
 *                 refused.
 *   SERVICES      comma-separated services to ENABLE: CAR_RENTAL, FLIGHT,
 *                 HOTEL. Any other value is refused — nothing is guessed.
 *   APPLY         "1" to write. Anything else = dry run.
 *   REMOVE        comma-separated services to DISABLE. Refused unless
 *                 ALLOW_REMOVE=1 is set as well.
 *   ALLOW_REMOVE  "1" to confirm the REMOVE list.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINE `$addToSet`:
 *
 *   An organization stored before `serviceTypes` existed — both incumbent
 *   brands — has NO such field, and every surface reads that as "sells car
 *   rental" (`serviceTypesOrDefault`). Mongo's `$addToSet` on an absent
 *   field creates the array with only the new value, so "add FLIGHT" would
 *   silently become "sell flights INSTEAD of cars": the car-rental form
 *   disappears and new car orders are refused. This script starts from what
 *   the organization sells TODAY and only ever adds to it
 *   (`mergeServiceTypes`).
 *
 * Properties:
 *   additive        enabling never removes anything. Disabling is a separate,
 *                   explicitly confirmed list, and can never leave an
 *                   organization selling nothing.
 *   order-keeping   the list is the create page's tab order: the existing
 *                   services stay first, as stored; new ones are appended in
 *                   the order requested. Duplicates collapse.
 *   idempotent      a run that changes nothing writes nothing.
 *   guarded         the write matches the list exactly as it was read, so a
 *                   change made meanwhile (another run, the admin UI) aborts
 *                   this one rather than being overwritten.
 *   narrow          it writes `serviceTypes` and nothing else — no order,
 *                   legal text, credential or member is touched. Existing
 *                   orders of a disabled service stay readable; only new
 *                   ones are refused.
 */

import mongoose, { type Types } from "mongoose";

import { env } from "../src/lib/env";
import { Order, Organization } from "../src/server/db/models";
import { ServiceType } from "../src/lib/constants/enums";
import {
  mergeServiceTypes,
  parseServiceTypeList,
  removeServiceTypes,
  serviceTypesOrDefault,
} from "../src/lib/organization-service-types";

const APPLY = process.env.APPLY === "1";
const ALLOW_REMOVE = process.env.ALLOW_REMOVE === "1";
const SLUG = (process.env.ORG_SLUG ?? "").trim().toLowerCase();

interface OrgRow {
  _id: Types.ObjectId;
  slug: string;
  brandName: string;
  status: string;
  isDefault?: boolean;
  /** Typed as the schema declares it; `mergeServiceTypes` still refuses
   *  any stored value that is not a service type. */
  serviceTypes?: ServiceType[] | null;
}

function list(values: readonly string[]): string {
  return values.length > 0 ? `[${values.join(", ")}]` : "[]";
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Connect WITHOUT building indexes or creating collections. The app's
 * shared connectMongo() turns autoIndex on whenever NODE_ENV is not
 * "production" — run from a laptop against the production database, that
 * would start building every index the models declare (and create every
 * missing collection) before even a dry run had read the organization.
 * This script reads, and with APPLY=1 updates, one field of one document;
 * nothing else.
 */
async function connectReadOnlySchema(): Promise<void> {
  const { MONGODB_URI, MONGODB_DB } = env.server;
  await mongoose.connect(MONGODB_URI, {
    dbName: MONGODB_DB,
    bufferCommands: false,
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
    autoCreate: false,
  });
}

async function main() {
  // Every input is checked BEFORE the database is touched.
  if (!SLUG) {
    throw new Error("Set ORG_SLUG to the organization's slug.");
  }
  const add = parseServiceTypeList(process.env.SERVICES);
  const remove = parseServiceTypeList(process.env.REMOVE);
  if (remove.length > 0 && !ALLOW_REMOVE) {
    throw new Error(
      `REMOVE would disable ${list(remove)}. Set ALLOW_REMOVE=1 as well to confirm.`,
    );
  }
  if (add.length === 0 && remove.length === 0) {
    throw new Error(
      "Nothing to do: set SERVICES to a comma-separated list (CAR_RENTAL, FLIGHT, HOTEL).",
    );
  }
  const both = add.filter((s) => remove.includes(s));
  if (both.length > 0) {
    throw new Error(`${list(both)} is in both SERVICES and REMOVE.`);
  }

  console.log(
    `→ Setting the services of organization "${SLUG}"${
      APPLY ? "" : " (dry run — set APPLY=1 to write)"
    }`,
  );

  await connectReadOnlySchema();

  const org = await Organization.findOne({ slug: SLUG })
    .select("_id slug brandName status isDefault serviceTypes")
    .lean<OrgRow | null>();
  if (!org) {
    const known = await Organization.find({})
      .select("slug")
      .lean<{ slug: string }[]>();
    throw new Error(
      `No organization with slug "${SLUG}". Known slugs: ${
        known.map((o) => o.slug).join(", ") || "(none)"
      }.`,
    );
  }

  // `.lean()` applies no schema defaults: an organization stored before the
  // field existed arrives with no `serviceTypes` key at all.
  const stored =
    Array.isArray(org.serviceTypes) && org.serviceTypes.length > 0
      ? org.serviceTypes
      : null;
  let after = mergeServiceTypes(stored, add);
  if (remove.length > 0) after = removeServiceTypes(after, remove);
  const before = serviceTypesOrDefault(stored);
  const enabling = after.filter((s) => !before.includes(s));
  const disabling = before.filter((s) => !after.includes(s));

  console.log(
    `  • organization   ${org.brandName} (${org.slug}, ${String(org._id)}, ${org.status}${
      org.isDefault ? ", default" : ""
    })`,
  );
  console.log(
    `  • stored         ${stored ? list(stored) : "(none stored — reads as [CAR_RENTAL])"}`,
  );
  console.log(`  • before         ${list(before)}`);
  console.log(`  • after          ${list(after)}`);
  console.log(`  • enabling       ${list(enabling)}`);
  console.log(`  • disabling      ${list(disabling)}`);

  // What disabling leaves behind: those orders stay readable, but no new
  // one can be created for the service.
  for (const service of disabling) {
    const owned = org.isDefault
      ? { $or: [{ organizationId: org._id }, { organizationId: null }] }
      : { organizationId: org._id };
    const ofService =
      service === ServiceType.CAR_RENTAL
        ? // Orders stored before `serviceType` existed are car rentals.
          { serviceType: { $in: [ServiceType.CAR_RENTAL, null] } }
        : { serviceType: service };
    const existing = await Order.countDocuments({ $and: [owned, ofService] });
    console.log(
      `    – ${service}: ${existing} existing order(s) stay readable; new ones will be refused`,
    );
  }

  if (sameList(before, after)) {
    console.log("  • nothing to change: no writes made");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log("  • dry run: no writes made");
    await mongoose.disconnect();
    return;
  }

  // Guarded: matches only while the list is still exactly what was read
  // above. Exact array equality — order included — for a stored list;
  // absent / null / empty for an organization that never stored one.
  const unchangedSinceRead = stored
    ? { serviceTypes: stored }
    : {
        $or: [
          { serviceTypes: { $exists: false } },
          { serviceTypes: null },
          { serviceTypes: { $size: 0 } },
        ],
      };
  const res = await Organization.updateOne(
    { _id: org._id, ...unchangedSinceRead },
    { $set: { serviceTypes: after } },
    { runValidators: true },
  );
  if (res.matchedCount === 0) {
    throw new Error(
      "The organization's services changed while this ran — nothing was written. Re-run to see the current list.",
    );
  }

  const written = await Organization.findById(org._id)
    .select("serviceTypes")
    .lean<{ serviceTypes?: string[] } | null>();
  console.log(`  ✓ stored ${list(written?.serviceTypes ?? [])}`);
  console.log("✔ Organization services updated.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(
    "set-organization-services failed:",
    err instanceof Error ? err.message : err,
  );
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
