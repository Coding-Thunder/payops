/**
 * ⚠ PRODUCTION-CONTENT TODO — THIS SEED IS PLACEHOLDER DATA.
 *
 * The six properties below are plausible STARTER rows, not a real
 * FlightBizz inventory: the names are invented, the descriptions and
 * amenities are written to be representative rather than accurate, and
 * every photo is a generic images.unsplash.com URL that is NOT licensed
 * for a commercial storefront and is NOT hosted by us.
 *
 * Before FlightBizz takes a real booking, replace: property names and
 * addresses with real inventory, descriptions/amenities with contracted
 * detail, and every image URL with licensed assets on our own storage.
 * Nothing here should reach a paying customer as-is.
 */
/* eslint-disable no-console */
/**
 * Seed the shared hotel catalog.
 *
 * Run (reports only, writes nothing):
 *   npm run seed:hotels
 *
 * Apply for real:
 *   SEED_HOTELS_APPLY=true npm run seed:hotels
 *
 * Knobs (env vars):
 *   SEED_HOTELS_APPLY   "true" to write. Anything else = dry run.
 *   SEED_HOTELS_ACTOR_EMAIL
 *                       email of an EXISTING user to attribute the rows to.
 *                       Optional — when unset the script picks an active
 *                       SUPER_ADMIN (then any active admin/user). It never
 *                       creates a user and never fabricates an ObjectId.
 *
 * WHY A SEED SCRIPT AT ALL: the hotel selector on the FlightBizz order form
 * is a search over `hotels`. An empty collection means the operator has
 * nothing to pick and the HOTEL order type is unusable, so the catalog needs
 * a starting set the same way `providers` ships with a seed set.
 *
 * NOT ORGANIZATION-SCOPED, deliberately, and consistent with `car_links` and
 * with `hotel.model.ts`: the catalog is reference data about the world, not
 * about a tenant. Nothing here carries an `organizationId`, and a hotel row
 * grants access to nothing — tenancy lives on the ORDER.
 *
 * NON-REGRESSION: RentalConfirmation and TripReservations are CAR_RENTAL-only
 * brands. They never read `hotels`, so rows added here cannot appear on any of
 * their surfaces. Nothing existing is read-modified-written by this script.
 *
 * Properties:
 *   idempotent      each hotel is upserted on its natural key — name +
 *                   location.city — with `$setOnInsert` ONLY and
 *                   `timestamps: false`, so a re-run writes nothing at all,
 *                   moves no `updatedAt`, and never clobbers a description,
 *                   amenity list or image an operator has since edited in
 *                   the UI.
 *   collation-aware the lookup and the upsert both run under the same
 *                   `{ locale: "en", strength: 2 }` collation as the
 *                   `hotels_dedupe` unique index (name + city + country), so
 *                   a row that differs only in case is treated as the same
 *                   hotel rather than colliding with the index.
 *   non-destructive nothing is deleted, deactivated or edited. Existing rows
 *                   are reported and left exactly as they are.
 *   secret-free     it never reads or prints a credential.
 */

import type { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { Hotel, User } from "../src/server/db/models";
import { RecordState, UserRole } from "../src/lib/constants/enums";

const APPLY = process.env.SEED_HOTELS_APPLY === "true";

const ACTOR_EMAIL = (process.env.SEED_HOTELS_ACTOR_EMAIL ?? "")
  .trim()
  .toLowerCase();

/**
 * The `hotels_dedupe` unique index is declared with this collation. Every
 * read and every write below uses the identical setting — a query that does
 * not match the index's collation would miss a case-different duplicate and
 * then fail the insert against the index we were trying to respect.
 */
const DEDUPE_COLLATION = { locale: "en", strength: 2 } as const;

interface SeedImage {
  url: string;
  caption: string;
}

interface SeedHotel {
  name: string;
  description: string;
  city: string;
  country: string;
  address: string;
  amenities: string[];
  starRating: number;
  /** Order here IS the stored `sortOrder` — index 0 is the hero image. */
  images: SeedImage[];
}

/**
 * Stable public image URLs. `images.unsplash.com/photo-<id>` is a permanent,
 * hot-linkable CDN path; the query string only asks for a resized, format-
 * negotiated derivative. Every hotel carries several images because a hotel
 * listing with one photo does not read as credible — which is exactly why
 * `hotel.model.ts` models `images[]` as an array of subdocuments rather than
 * the single `imageUrl` string `car_links` uses.
 */
const IMG = (id: string) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1600&q=80`;

const HOTELS: SeedHotel[] = [
  {
    name: "The Marina Bay Grand",
    description:
      "Waterfront five-star tower on Dubai Marina, a ten-minute transfer from " +
      "DXB's Terminal 3. Rooms face either the marina or the Gulf, and the " +
      "34th-floor lounge is open to all guests.",
    city: "Dubai",
    country: "United Arab Emirates",
    address: "Al Marsa Street, Dubai Marina",
    amenities: [
      "Airport shuttle",
      "Rooftop pool",
      "Spa",
      "Fitness centre",
      "Free Wi-Fi",
      "Valet parking",
      "24-hour room service",
    ],
    starRating: 5,
    images: [
      { url: IMG("1566073771259-6a8506099945"), caption: "Hotel exterior at dusk" },
      { url: IMG("1590490360182-c33d57733427"), caption: "Marina-view king room" },
      { url: IMG("1571003123894-1f0594d2b5d9"), caption: "Rooftop infinity pool" },
      { url: IMG("1551882547-ff40c63fe5fa"), caption: "Lobby and reception" },
    ],
  },
  {
    name: "Harbour View Residences",
    description:
      "Serviced apartment-style rooms overlooking Marina Bay, connected to the " +
      "MRT and a 25-minute ride from Changi. Suited to longer corporate stays.",
    city: "Singapore",
    country: "Singapore",
    address: "12 Marina Boulevard",
    amenities: [
      "Kitchenette",
      "Laundry",
      "Business centre",
      "Free Wi-Fi",
      "Fitness centre",
      "Airport shuttle",
    ],
    starRating: 4,
    images: [
      { url: IMG("1582719478250-c89cae4dc85b"), caption: "Bay-facing facade" },
      { url: IMG("1578683010236-d716f9a3f461"), caption: "One-bedroom residence" },
      { url: IMG("1540518614846-7eded433c457"), caption: "Executive lounge" },
    ],
  },
  {
    name: "Alpine Crest Lodge",
    description:
      "Family-run lodge in the village centre with direct access to the " +
      "Sunnegga funicular. Half-board available on request; ski storage and " +
      "boot warming included.",
    city: "Zermatt",
    country: "Switzerland",
    address: "Bahnhofstrasse 41",
    amenities: [
      "Ski storage",
      "Sauna",
      "Restaurant",
      "Free Wi-Fi",
      "Pet friendly",
      "Breakfast included",
    ],
    starRating: 4,
    images: [
      { url: IMG("1520250497591-112f2f40a3f4"), caption: "Lodge and Matterhorn view" },
      { url: IMG("1587985064135-0366536eab42"), caption: "Alpine double room" },
      { url: IMG("1596394516093-501ba68a0ba6"), caption: "Sauna and relaxation room" },
      { url: IMG("1542314831-068cd1dbfeeb"), caption: "Restaurant terrace" },
    ],
  },
  {
    name: "The Thameside Regent",
    description:
      "Grade II listed riverside hotel between Westminster and Waterloo. " +
      "Heathrow Express connections from Paddington; direct rail to Gatwick " +
      "from Victoria.",
    city: "London",
    country: "United Kingdom",
    address: "18 Albert Embankment, Lambeth",
    amenities: [
      "Concierge",
      "Restaurant",
      "Bar",
      "Meeting rooms",
      "Free Wi-Fi",
      "Accessible rooms",
      "24-hour front desk",
    ],
    starRating: 5,
    images: [
      { url: IMG("1445019980597-93fa8acb246c"), caption: "Riverside frontage" },
      { url: IMG("1611892440504-42a792e24d32"), caption: "Regent suite" },
      { url: IMG("1551632436-cbf8dd35adfa"), caption: "Ground-floor bar" },
    ],
  },
  {
    name: "Casa del Sol Boutique",
    description:
      "Twenty-eight room boutique property in the Gothic Quarter, five " +
      "minutes on foot from Plaça de Catalunya and the airport bus terminus.",
    city: "Barcelona",
    country: "Spain",
    address: "Carrer dels Escudellers 27",
    amenities: [
      "Rooftop terrace",
      "Breakfast included",
      "Free Wi-Fi",
      "Air conditioning",
      "Luggage storage",
    ],
    starRating: 4,
    images: [
      { url: IMG("1568084680786-a84f91d1153c"), caption: "Interior courtyard" },
      { url: IMG("1631049307264-da0ec9d70304"), caption: "Boutique double room" },
      { url: IMG("1573052905904-34ad8c27f0cc"), caption: "Rooftop terrace" },
      { url: IMG("1584132967334-10e028bd69f7"), caption: "Breakfast room" },
    ],
  },
  {
    name: "Bayfront Pacific Hotel",
    description:
      "Embarcadero hotel facing the bay, walking distance to the Ferry " +
      "Building and BART. Thirty minutes to SFO outside peak hours.",
    city: "San Francisco",
    country: "United States",
    address: "455 The Embarcadero",
    amenities: [
      "Parking",
      "Fitness centre",
      "Free Wi-Fi",
      "Pet friendly",
      "Business centre",
      "EV charging",
    ],
    starRating: 4,
    images: [
      { url: IMG("1564501049412-61c2a3083791"), caption: "Bayfront exterior" },
      { url: IMG("1512918728675-ed5a9ecdebfd"), caption: "Bay-view queen room" },
      { url: IMG("1559599189-fe84dea4eb79"), caption: "Lobby lounge" },
    ],
  },
];

interface Actor {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: string;
}

/**
 * `createdBy` is REQUIRED by the schema and is a real `ref: "User"`. It must
 * therefore point at a user that exists — a fabricated ObjectId would render
 * as a dangling reference in the catalog UI and in every audit trail that
 * later touches the row. Prefer a SUPER_ADMIN, fall back to any active
 * admin, then any active user, and fail loudly rather than inventing one.
 */
async function resolveActor(): Promise<Actor> {
  if (ACTOR_EMAIL) {
    const named = await User.findOne({ email: ACTOR_EMAIL })
      .select("_id name email role")
      .lean<Actor | null>();
    if (!named) {
      throw new Error(
        `SEED_HOTELS_ACTOR_EMAIL is set to "${ACTOR_EMAIL}" but no such user exists. ` +
          "This script never creates users — correct the address or unset the variable.",
      );
    }
    return named;
  }

  for (const role of [UserRole.SUPER_ADMIN, UserRole.ADMIN]) {
    const found = await User.findOne({ role, status: RecordState.ACTIVE })
      .sort({ createdAt: 1 })
      .select("_id name email role")
      .lean<Actor | null>();
    if (found) return found;
  }

  const any = await User.findOne({ status: RecordState.ACTIVE })
    .sort({ createdAt: 1 })
    .select("_id name email role")
    .lean<Actor | null>();
  if (any) return any;

  throw new Error(
    "Refusing to run: no active user exists to attribute the catalog to, and " +
      "`Hotel.createdBy` is a required reference to a real user. Seed users first " +
      "(npm run seed), or set SEED_HOTELS_ACTOR_EMAIL to an existing account.",
  );
}

async function main() {
  console.log(
    `→ Seeding the shared hotel catalog (${HOTELS.length} properties)${
      APPLY ? "" : " (dry run — set SEED_HOTELS_APPLY=true to write)"
    }`,
  );

  await connectMongo();

  const actor = await resolveActor();
  console.log(
    `  • rows will be attributed to: ${actor.name} <${actor.email}> [${actor.role}] (${String(actor._id)})`,
  );
  console.log(
    "  • the hotels collection is SHARED reference data — no organizationId is written,",
  );
  console.log(
    "    matching car_links. RentalConfirmation and TripReservations never read it.",
  );

  // Resolve present/absent BEFORE any write so the dry run can report the
  // exact plan. The lookup keys on the natural key (name + city) under the
  // dedupe index's own collation.
  const plan: { seed: SeedHotel; existingId: string | null }[] = [];
  for (const seed of HOTELS) {
    const existing = await Hotel.findOne({
      name: seed.name,
      "location.city": seed.city,
    })
      .collation(DEDUPE_COLLATION)
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
    plan.push({ seed, existingId: existing ? String(existing._id) : null });
  }

  for (const { seed, existingId } of plan) {
    if (existingId) {
      console.log(
        `  • "${seed.name}" (${seed.city}) already exists (${existingId}) — it will be LEFT AS IS`,
      );
      continue;
    }
    console.log(`  • "${seed.name}" (${seed.city}) would be CREATED`);
    console.log(`    – country     ${seed.country}`);
    console.log(`    – address     ${seed.address}`);
    console.log(`    – stars       ${seed.starRating}`);
    console.log(`    – amenities   [${seed.amenities.join(", ")}]`);
    console.log(`    – images      ${seed.images.length}`);
    seed.images.forEach((img, i) => {
      console.log(`      ${i}. "${img.caption}" ${img.url}`);
    });
  }

  const wouldCreate = plan.filter((p) => !p.existingId).length;
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
     * `timestamps: false` — as in seed-globevista.ts — keeps a re-run a TRUE
     * no-op: Mongoose otherwise appends `$set: { updatedAt }` to every
     * findOneAndUpdate, including one whose only operator is `$setOnInsert`.
     * Because that also suppresses the timestamps on INSERT, both dates are
     * written explicitly in `$setOnInsert` — `hotel.service.toDTO()` calls
     * `doc.createdAt.toISOString()` unguarded, so a row without them would
     * blow up the catalog list.
     *
     * `name` and `location.city` are omitted from `$setOnInsert` on purpose:
     * they are the upsert's equality conditions and MongoDB already copies
     * them into the new document. `location.country` / `location.address`
     * are written as DOTTED paths rather than as a whole `location` object,
     * because setting the parent path while the filter pins `location.city`
     * is a path conflict that MongoDB rejects.
     */
    const now = new Date();
    const before = await Hotel.findOneAndUpdate(
      { name: seed.name, "location.city": seed.city },
      {
        $setOnInsert: {
          description: seed.description,
          "location.country": seed.country,
          "location.address": seed.address,
          amenities: seed.amenities,
          images: seed.images.map((img, i) => ({
            url: img.url,
            caption: img.caption,
            // Ascending, explicit, and dense — array position is only the
            // tiebreaker in the model's contract.
            sortOrder: i,
          })),
          starRating: seed.starRating,
          notes: null,
          createdBy: { userId: actor._id, name: actor.name },
          active: true,
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
        collation: DEDUPE_COLLATION,
      },
    ).lean<{ _id: Types.ObjectId } | null>();

    if (before) {
      already += 1;
    } else {
      created += 1;
      console.log(`  ✓ created "${seed.name}" (${seed.city})`);
    }
  }

  console.log(`  ✓ hotels created ${created}, already present ${already}`);
  console.log("");
  console.log("  NEXT STEPS (none of which this script performs):");
  console.log(
    "   1. Run `npm run indexes:audit` — production runs autoIndex:false, so the",
  );
  console.log(
    "      hotels_dedupe unique index and the name+city selector index are NOT",
  );
  console.log("      created automatically.");
  console.log(
    "   2. Review descriptions, amenities and photos in the admin UI — these are",
  );
  console.log(
    "      plausible starter rows, not licensed content for a live storefront.",
  );
  console.log("✔ Hotel catalog seed complete.");

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Hotel catalog seed failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
