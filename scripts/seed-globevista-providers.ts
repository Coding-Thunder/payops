/**
 * ⚠ PRODUCTION-CONTENT TODO — LOGOS ARE PLACEHOLDERS.
 *
 * Every provider created here points `logo` at the neutral placeholder
 * `/providers/_placeholder.svg`, because no licensed airline or hotel-group
 * mark exists in this repo and shipping one without permission is a
 * trademark problem, not a cosmetic one.
 *
 * Before FlightBizz is customer-facing, upload the real marks through the
 * admin provider UI (which writes to public/providers/) for each key seeded
 * below. The provider name and colours are safe to keep; the logo is not.
 */
/* eslint-disable no-console */
/**
 * Seed GlobeVista's (customer brand: FlightBizz) flight and hotel suppliers
 * into the shared `providers` catalog.
 *
 * Run (reports only, writes nothing):
 *   npm run seed:globevista-providers
 *
 * Apply for real:
 *   SEED_GV_PROVIDERS_APPLY=true npm run seed:globevista-providers
 *
 * Knobs (env vars):
 *   SEED_GV_PROVIDERS_APPLY   "true" to write. Anything else = dry run.
 *
 * WHY THIS SCRIPT EXISTS: `ensureSeedProviders()` only ever inserts
 * `PROVIDER_SEED`, which is six CAR-RENTAL brands. Without a flight or hotel
 * supplier in the catalog the FlightBizz order forms have an empty provider
 * dropdown and no FLIGHT or HOTEL order can be created at all.
 *
 * ═══ THE NON-REGRESSION RULE THIS SCRIPT TURNS ON ═══════════════════════
 *
 *   `organizationIds: []` means "AVAILABLE TO EVERY ORGANIZATION" — see
 *   provider.model.ts and `listProviders()`. That is what every pre-existing
 *   row means, which is why no incumbent row needed a backfill. It is also
 *   the trap here: a row seeded with an empty list would put Emirates and
 *   Marriott into RentalConfirmation's and TripReservations' provider
 *   catalogs. Every row created below therefore carries
 *   `organizationIds: [<GlobeVista _id>]`, and the script REFUSES TO RUN if
 *   the GlobeVista organization does not exist rather than falling back to
 *   an unrestricted row.
 *
 *   The `serviceTypes` filter is a second, independent guard: the two
 *   incumbents are CAR_RENTAL-only, and `listProviders({ serviceType:
 *   CAR_RENTAL })` matches only rows carrying CAR_RENTAL (or predating the
 *   field). Nothing seeded here carries CAR_RENTAL, so even an operator who
 *   later clears the organization restriction does not get an airline on a
 *   car-rental form.
 *
 * Properties:
 *   idempotent      each supplier is upserted on `key` — the collection's
 *                   unique natural key — with `$setOnInsert` ONLY and
 *                   `timestamps: false`, so a re-run writes nothing, moves
 *                   no `updatedAt`, and never clobbers a name, colour or
 *                   logo an admin has since edited in the UI.
 *   non-destructive NO existing provider row is modified or re-stamped. A
 *                   key that is already taken is reported, left untouched,
 *                   and — because a pre-existing row could be an unrelated
 *                   car-rental supplier — flagged loudly.
 *   secret-free     it never reads or prints a credential.
 */

import type { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Organization, Provider } from "../src/server/db/models";
import { RecordState, ServiceType } from "../src/lib/constants/enums";
import {
  PROVIDER_KEY_REGEX,
  UNKNOWN_PROVIDER,
} from "../src/lib/constants/providers";

const APPLY = process.env.SEED_GV_PROVIDERS_APPLY === "true";
/** Opt-in: restrict the seeded suppliers to GlobeVista only. Off by
 *  default, because the provider catalog is shared reference data. */
const RESTRICT_TO_GLOBEVISTA =
  process.env.SEED_GV_PROVIDERS_RESTRICT === "true";

/** The organization these suppliers are restricted to. */
const SLUG = "globevista";
const BRAND_NAME = "FlightBizz";

/**
 * `logo` is REQUIRED by the schema and is a public path under /public. The
 * incumbent rows point at real files (`/providers/hertz.png` …); there is no
 * licensed airline or hotel-group mark in the repository, and inventing a
 * path would render a broken image in the selector and on the customer's
 * receipt. The shipped neutral placeholder — the same one `resolveProvider()`
 * falls back to — is the honest stand-in until an operator uploads the real
 * mark through the admin UI, which rewrites this field.
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
 * `sortOrder` starts well above the car-rental block (0–5) so the two sets
 * never interleave in an unfiltered admin listing, which sorts by
 * sortOrder then name.
 */
const AIRLINES: SeedProvider[] = [
  {
    key: "EMIRATES",
    name: "Emirates",
    tagline: "Long-haul via Dubai",
    primaryColor: "#D71921",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 100,
  },
  {
    key: "QATAR_AIRWAYS",
    name: "Qatar Airways",
    tagline: "Long-haul via Doha",
    primaryColor: "#5C0632",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 101,
  },
  {
    key: "SINGAPORE_AIRLINES",
    name: "Singapore Airlines",
    tagline: "Asia-Pacific network",
    primaryColor: "#F1AB00",
    onPrimaryColor: "#111111",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 102,
  },
  {
    key: "LUFTHANSA",
    name: "Lufthansa",
    tagline: "European and transatlantic network",
    primaryColor: "#05164D",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.FLIGHT],
    sortOrder: 103,
  },
];

const HOTEL_GROUPS: SeedProvider[] = [
  {
    key: "MARRIOTT",
    name: "Marriott International",
    tagline: "Global hotel group",
    primaryColor: "#8C1D40",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.HOTEL],
    sortOrder: 200,
  },
  {
    key: "HILTON",
    name: "Hilton",
    tagline: "Global hotel group",
    primaryColor: "#104C97",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.HOTEL],
    sortOrder: 201,
  },
  {
    key: "ACCOR",
    name: "Accor",
    tagline: "European hotel group",
    primaryColor: "#1B2A4A",
    onPrimaryColor: "#FFFFFF",
    serviceTypes: [ServiceType.HOTEL],
    sortOrder: 202,
  },
];

const SEEDS: SeedProvider[] = [...AIRLINES, ...HOTEL_GROUPS];

async function main() {
  console.log(
    `→ Seeding ${AIRLINES.length} airlines + ${HOTEL_GROUPS.length} hotel groups for "${BRAND_NAME}" (slug ${SLUG})${
      APPLY ? "" : " (dry run — set SEED_GV_PROVIDERS_APPLY=true to write)"
    }`,
  );

  // Fail before touching the database if a key could never be stored: the
  // schema enforces PROVIDER_KEY_REGEX, and a violation would surface as a
  // mid-loop validation error with half the catalog written.
  const malformed = SEEDS.filter((p) => !PROVIDER_KEY_REGEX.test(p.key));
  if (malformed.length > 0) {
    throw new Error(
      `Refusing to run: malformed provider keys ${malformed
        .map((p) => p.key)
        .join(", ")} — must match ${String(PROVIDER_KEY_REGEX)}`,
    );
  }

  await connectMongo();

  // THE GUARD. An unresolvable organization must abort, never degrade into
  // an unrestricted row — `organizationIds: []` would publish airlines to
  // RentalConfirmation and TripReservations.
  const org = await Organization.findOne({ slug: SLUG })
    .select("_id name brandName")
    .lean<{
      _id: Types.ObjectId;
      name: string;
      brandName: string;
    } | null>();
  if (!org) {
    throw new Error(
      `Refusing to run: no organization with slug "${SLUG}" exists. Run ` +
        "`npm run seed:globevista` first. This script will NOT create providers " +
        "without an organization to restrict them to, because an unrestricted " +
        "row is visible to every brand on the deployment.",
    );
  }
  const orgId = org._id;
  console.log(
    `  • restricting every new row to organizationIds: [${String(orgId)}] (${org.name} / ${org.brandName})`,
  );
  console.log(
    "    an EMPTY list would mean \"every organization\" and would leak these",
  );
  console.log(
    "    suppliers into RentalConfirmation's and TripReservations' dropdowns.",
  );
  console.log(`  • logo for every new row: ${PLACEHOLDER_LOGO} (neutral placeholder)`);

  // Resolve present/absent BEFORE any write so the dry run reports the exact
  // plan and so an already-taken key can be inspected rather than upserted
  // blind.
  const plan: {
    seed: SeedProvider;
    existing: {
      _id: Types.ObjectId;
      name: string;
      serviceTypes?: ServiceType[];
      organizationIds?: Types.ObjectId[];
    } | null;
  }[] = [];
  for (const seed of SEEDS) {
    const existing = await Provider.findOne({ key: seed.key })
      .select("_id name serviceTypes organizationIds")
      .lean<{
        _id: Types.ObjectId;
        name: string;
        serviceTypes?: ServiceType[];
        organizationIds?: Types.ObjectId[];
      } | null>();
    plan.push({ seed, existing });
  }

  for (const { seed, existing } of plan) {
    if (existing) {
      const types = existing.serviceTypes?.length
        ? existing.serviceTypes.join(", ")
        : "(unset — treated as CAR_RENTAL)";
      const orgs = existing.organizationIds?.length
        ? existing.organizationIds.map(String).join(", ")
        : "(empty — every organization)";
      console.log(
        `  • key ${seed.key} is ALREADY TAKEN (${String(existing._id)}, "${existing.name}") — it will be LEFT AS IS`,
      );
      console.log(`    – existing serviceTypes    ${types}`);
      console.log(`    – existing organizationIds ${orgs}`);
      if (!existing.serviceTypes?.includes(seed.serviceTypes[0]!)) {
        console.log(
          `    ! that row does NOT offer ${seed.serviceTypes.join("/")}, so this seed adds nothing for ${BRAND_NAME}.`,
        );
        console.log(
          "      Fix it in the admin UI — this script never re-stamps an existing row.",
        );
      }
      continue;
    }
    console.log(`  • ${seed.key} would be CREATED`);
    console.log(`    – name             ${seed.name}`);
    console.log(`    – tagline          ${seed.tagline}`);
    console.log(`    – serviceTypes     [${seed.serviceTypes.join(", ")}]`);
    console.log(`    – organizationIds  [${String(orgId)}]`);
    console.log(`    – logo             ${PLACEHOLDER_LOGO}`);
    console.log(
      `    – colours          ${seed.primaryColor} on-text ${seed.onPrimaryColor}`,
    );
    console.log(`    – sortOrder        ${seed.sortOrder}`);
    console.log(`    – status           ${RecordState.ACTIVE}`);
  }

  const wouldCreate = plan.filter((p) => !p.existing).length;
  const wouldSkip = plan.length - wouldCreate;

  if (!APPLY) {
    console.log(
      `  • dry run: no writes made (${wouldCreate} would be created, ${wouldSkip} already present)`,
    );
    await disconnectMongo();
    return;
  }

  let created = 0;
  let already = 0;

  for (const { seed } of plan) {
    /**
     * `$setOnInsert` ONLY, so a second run cannot re-stamp a row an admin
     * has edited — including one this script created and someone has since
     * renamed or given a real logo.
     *
     * `timestamps: false` keeps the re-run a TRUE no-op (Mongoose otherwise
     * appends `$set: { updatedAt }` to every findOneAndUpdate). Because that
     * also suppresses the timestamps on INSERT, both are written explicitly:
     * `provider.service.toDTO()` calls `doc.createdAt.toISOString()`
     * unguarded, so a row missing them would break the catalog listing.
     *
     * `key` is omitted from `$setOnInsert` — it is the upsert's equality
     * condition and MongoDB copies it into the new document.
     */
    const now = new Date();
    const before = await Provider.findOneAndUpdate(
      { key: seed.key },
      {
        $setOnInsert: {
          name: seed.name,
          logo: PLACEHOLDER_LOGO,
          primaryColor: seed.primaryColor,
          onPrimaryColor: seed.onPrimaryColor,
          tagline: seed.tagline,
          status: RecordState.ACTIVE,
          serviceTypes: seed.serviceTypes,
          // NEVER [] — see the header. Restriction is the whole point.
          // GLOBAL BY DEFAULT. `organizationIds: []` means "available to every
      // organization", which is the correct model for a shared catalog: a
      // supplier is reference data about the world, not the property of the
      // brand that happened to add it. An airline added from FlightBizz
      // should be reusable by any organization that sells flights.
      //
      // Isolation is carried by `serviceTypes`, NOT by this field: the
      // CAR_RENTAL query branch matches only rows that are CAR_RENTAL,
      // absent, or empty, so a ["FLIGHT"] row can never surface in
      // RentalConfirmation's or TripReservations's rental dropdown.
      //
      // Set SEED_GV_PROVIDERS_RESTRICT=true to scope these rows to
      // GlobeVista instead — an explicit opt-in, not the default.
      organizationIds: RESTRICT_TO_GLOBEVISTA ? [orgId] : [],
          sortOrder: seed.sortOrder,
          createdBy: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        upsert: true,
        // "before" so a null result means THIS run inserted the row.
        returnDocument: "before",
        setDefaultsOnInsert: true,
        timestamps: false,
      },
    ).lean<{ _id: Types.ObjectId } | null>();

    if (before) {
      already += 1;
    } else {
      created += 1;
      console.log(`  ✓ created ${seed.key} (${seed.name})`);
    }
  }

  console.log(`  ✓ providers created ${created}, already present ${already}`);
  console.log("");
  console.log("  NEXT STEPS (none of which this script performs):");
  console.log(
    `   1. Upload real brand marks in the admin UI — every new row points at ${PLACEHOLDER_LOGO}.`,
  );
  console.log(
    "   2. Confirm in the admin provider list that the CAR_RENTAL rows are unchanged and",
  );
  console.log(
    "      that none of the new rows shows an empty organization restriction.",
  );
  console.log(
    "   3. Run `npm run indexes:audit` — production runs autoIndex:false, so the",
  );
  console.log(
    "      serviceTypes and organizationIds indexes are not created automatically.",
  );
  console.log(`✔ ${BRAND_NAME} provider seed complete.`);

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("FlightBizz provider seed failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
