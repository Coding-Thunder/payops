/**
 * ⚠ PRODUCTION-CONTENT NOTE — LOGOS ARE PLACEHOLDERS.
 *
 * Every supplier created here points `logo` at the neutral placeholder
 * `/providers/_placeholder.svg`, because no licensed airline or cruise-line
 * mark exists in this repository and shipping one without permission is a
 * trademark problem, not a cosmetic one.
 *
 * Before RCR Cruise goes customer-facing, upload the real marks through
 * Admin → Providers for each key seeded below. That writes the bytes to the
 * GridFS asset store and rewrites `logo` to an `/api/assets/<id>` URL, which
 * is what every customer-facing surface then resolves. The supplier name and
 * colours are safe to keep; the logo is not.
 */
/* eslint-disable no-console */
/**
 * Seed RCR Cruise's airline and cruise-line suppliers into the `providers`
 * catalog.
 *
 * Run (reports only, writes nothing):
 *   PAYOPS_ENV_DIR=rcr-env npm run seed:rcr-providers
 *
 * Apply for real:
 *   PAYOPS_ENV_DIR=rcr-env SEED_RCR_PROVIDERS_APPLY=true \
 *     npm run seed:rcr-providers
 *
 * WHY THIS SCRIPT EXISTS: `ensureSeedProviders()` only ever inserts
 * `PROVIDER_SEED`, which is six CAR-RENTAL brands — and on a deployment that
 * does not sell car rental it now inserts nothing at all, deliberately.
 * Without a flight or cruise supplier in the catalog the RCR Cruise order
 * forms have an empty supplier dropdown and no order can be created.
 *
 * Properties:
 *   idempotent      each supplier is upserted on `key` — the collection's
 *                   unique natural key — with `$setOnInsert` ONLY and
 *                   `timestamps: false`, so a re-run writes nothing, moves
 *                   no `updatedAt`, and never clobbers a name, colour or
 *                   logo an admin has since edited in the UI.
 *   non-destructive NO existing provider row is modified or re-stamped. A
 *                   key that is already taken is reported, left untouched,
 *                   and flagged loudly — a pre-existing row could be an
 *                   unrelated supplier that happens to share a key.
 *   secret-free     it never reads or prints a credential.
 *
 * TWO INDEPENDENT GUARDS keep these suppliers out of the other tenant's
 * catalog, because this database is SHARED:
 *
 *   1. `organizationIds: [<RCR Cruise>]` — restricts every row to one
 *      organization. An empty list would mean "every organization", which is
 *      why this script refuses to run before the organization exists.
 *   2. `serviceTypes` carries no CAR_RENTAL. `listProviders({ serviceType })`
 *      matches CAR_RENTAL against rows carrying it or predating the field,
 *      so even if the restriction were later cleared, an airline still could
 *      not surface on a car-rental form.
 */

import type { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Organization, Provider } from "../src/server/db/models";
import { RecordState, ServiceType } from "../src/lib/constants/enums";
import {
  PROVIDER_KEY_REGEX,
  UNKNOWN_PROVIDER,
} from "../src/lib/constants/providers";

const APPLY = process.env.SEED_RCR_PROVIDERS_APPLY === "true";

/**
 * The organization these suppliers belong to.
 *
 * REQUIRED, and the script refuses to run without it. `providers` is a
 * SHARED collection: this deployment's database holds every tenant's
 * catalog, and a row with an empty `organizationIds` is visible to ALL of
 * them. Seeding thirteen airlines and cruise lines unrestricted would put
 * them straight into the car-rental brand's admin catalog.
 *
 * Defaults to the slug the organization seed uses, so the two scripts agree
 * without a second variable to keep in sync.
 */
const ORG_SLUG = (
  process.env.SEED_RCR_PROVIDERS_ORG ??
  process.env.SEED_ORGS_SLUG ??
  "rcrcruise"
)
  .trim()
  .toLowerCase();

/**
 * `logo` is REQUIRED by the schema and is a public path or asset URL. There
 * is no licensed airline or cruise-line mark in this repository, and
 * inventing a path would render a broken image in the selector and on the
 * customer's receipt. The shipped neutral placeholder — the same one
 * `resolveProvider()` falls back to — is the honest stand-in until an
 * operator uploads the real mark through the admin UI, which rewrites this
 * field.
 */
const PLACEHOLDER_LOGO = UNKNOWN_PROVIDER.logo;

interface SeedProvider {
  key: string;
  name: string;
  tagline: string;
  primaryColor: string;
  onPrimaryColor: string;
  serviceTypes: ServiceType[];
  sortOrder: number;
}

/**
 * `sortOrder` starts well above the car-rental block (0–5) so the sets never
 * interleave in an unfiltered admin listing, which sorts by sortOrder then
 * name. Airlines occupy 100+, cruise lines 200+.
 */
const AIRLINES: SeedProvider[] = [
  {
    key: "AMERICAN_AIRLINES",
    name: "American Airlines",
    tagline: "US domestic and transatlantic",
    primaryColor: "#0078D2",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 100,
  },
  {
    key: "DELTA",
    name: "Delta Air Lines",
    tagline: "US domestic and long-haul",
    primaryColor: "#003366",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 101,
  },
  {
    key: "UNITED",
    name: "United Airlines",
    tagline: "Global network via US hubs",
    primaryColor: "#002244",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 102,
  },
  {
    key: "BRITISH_AIRWAYS",
    name: "British Airways",
    tagline: "Transatlantic via London",
    primaryColor: "#075AAA",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 103,
  },
  {
    key: "EMIRATES",
    name: "Emirates",
    tagline: "Long-haul via Dubai",
    primaryColor: "#D71921",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 104,
  },
  {
    key: "LUFTHANSA",
    name: "Lufthansa",
    tagline: "European and long-haul via Frankfurt",
    primaryColor: "#05164D",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 105,
  },
];

const CRUISE_LINES: SeedProvider[] = [
  {
    key: "ROYAL_CARIBBEAN",
    name: "Royal Caribbean",
    tagline: "Caribbean and Mediterranean megaships",
    primaryColor: "#003DA5",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 200,
  },
  {
    key: "CARNIVAL",
    name: "Carnival Cruise Line",
    tagline: "Short Caribbean and Bahamas sailings",
    primaryColor: "#0057B8",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 201,
  },
  {
    key: "NORWEGIAN",
    name: "Norwegian Cruise Line",
    tagline: "Freestyle cruising, Caribbean and Alaska",
    primaryColor: "#003595",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 202,
  },
  {
    key: "MSC_CRUISES",
    name: "MSC Cruises",
    tagline: "Mediterranean and Caribbean",
    primaryColor: "#0C2340",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 203,
  },
  {
    key: "PRINCESS",
    name: "Princess Cruises",
    tagline: "Alaska, Europe and world voyages",
    primaryColor: "#003C71",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 204,
  },
  {
    key: "CELEBRITY",
    name: "Celebrity Cruises",
    tagline: "Premium Caribbean and Europe",
    primaryColor: "#0B1F3B",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.CRUISE],
    sortOrder: 205,
  },
];

/**
 * A consolidator that sells both. Deliberately included: it is the row that
 * proves a supplier can serve more than one service, and it is what an
 * operator selects when the fare was sourced through an agency rather than
 * booked directly with the carrier or the line.
 */
const MULTI_SERVICE: SeedProvider[] = [
  {
    key: "RCR_TRAVEL",
    name: "RCR Travel",
    tagline: "Booked directly by RCR Cruise",
    primaryColor: "#0B4F6C",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT, ServiceType.CRUISE],
    sortOrder: 90,
  },
];

const ALL: SeedProvider[] = [...MULTI_SERVICE, ...AIRLINES, ...CRUISE_LINES];

async function main() {
  console.log(
    `→ Seeding RCR Cruise suppliers${
      APPLY ? "" : " (dry run — pass SEED_RCR_PROVIDERS_APPLY=true to write)"
    }`,
  );

  // Fail before touching the database rather than writing a row the schema
  // would reject halfway through the list.
  for (const p of ALL) {
    if (!PROVIDER_KEY_REGEX.test(p.key)) {
      throw new Error(`Provider key ${p.key} does not match PROVIDER_KEY_REGEX`);
    }
  }

  await connectMongo();

  // Resolve the owning organization FIRST. Refusing here is deliberate: an
  // unrestricted supplier row cannot be un-leaked once other tenants have
  // seen it, so "seed it globally and fix later" is not an option.
  const org = await Organization.findOne({ slug: ORG_SLUG })
    .select("_id slug brandName")
    .lean<{ _id: Types.ObjectId; slug: string; brandName: string } | null>();

  if (!org) {
    throw new Error(
      `Organization "${ORG_SLUG}" does not exist. Run \`npm run seed:orgs\` first — ` +
        "these suppliers must be restricted to an organization, never seeded globally.",
    );
  }
  console.log(`  • restricting all suppliers to "${org.brandName}" (${org.slug})`);

  const existing = new Set(
    (
      await Provider.find({ key: { $in: ALL.map((p) => p.key) } }, { key: 1 })
        .lean<{ key: string }[]>()
    ).map((p) => p.key),
  );

  const toCreate = ALL.filter((p) => !existing.has(p.key));
  const skipped = ALL.filter((p) => existing.has(p.key));

  for (const p of toCreate) {
    console.log(
      `  • WOULD CREATE ${p.key.padEnd(20)} ${p.name} [${p.serviceTypes.join(", ")}]`,
    );
  }
  for (const p of skipped) {
    console.log(
      `  • EXISTS       ${p.key.padEnd(20)} left untouched (verify it is the supplier you expect)`,
    );
  }

  if (!APPLY) {
    console.log(`  • dry run: no writes made (${toCreate.length} would be created)`);
    await disconnectMongo();
    return;
  }

  let created = 0;
  const now = new Date();
  for (const p of toCreate) {
    // `$setOnInsert` ONLY, so a re-run writes nothing and never clobbers a
    // name, colour or logo an admin has since edited in the UI.
    //
    // `timestamps: false` disables Mongoose's automatic stamping, which is
    // what stops a re-run touching `updatedAt` — but it disables it on the
    // INSERT too, so both fields must be supplied here. Omitting them
    // produced catalog rows with no `createdAt`, and `toDTO()` then threw on
    // `.toISOString()` and took the whole create-order page down with a 500.
    // Inside `$setOnInsert` they are written on creation and on no other run.
    const res = await Provider.updateOne(
      { key: p.key },
      {
        $setOnInsert: {
          key: p.key,
          name: p.name,
          logo: PLACEHOLDER_LOGO,
          primaryColor: p.primaryColor,
          onPrimaryColor: p.onPrimaryColor,
          tagline: p.tagline,
          serviceTypes: p.serviceTypes,
          // Restricted, never global — see the note on ORG_SLUG.
          organizationIds: [org._id],
          status: RecordState.ACTIVE,
          sortOrder: p.sortOrder,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, timestamps: false },
    );
    if (res.upsertedCount > 0) created += 1;
  }

  console.log(`  ✓ created ${created}, already present ${skipped.length}`);
  console.log(
    "  ⚠ Logos are placeholders — upload the real marks in Admin → Providers before going live.",
  );
  console.log("✔ RCR Cruise supplier seed complete.");
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("RCR provider seed failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
