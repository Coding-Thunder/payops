import "server-only";

/**
 * The console used to own a second Mongoose connection helper, cached on
 * `global.__adminMongoose`, because it ran in its own process.
 *
 * Inside the main app that is actively wrong: Mongoose's `mongoose.connect()`
 * operates on the ONE default connection, so two independently-cached helpers
 * race to open (and re-open) the same connection with different options —
 * `maxPoolSize` 5 vs 10, and, more importantly, the console's helper omitted
 * `autoIndex` entirely (Mongoose defaults it to `true`) while the main app
 * pins it to `false` in production. Whichever helper connected first silently
 * decided whether production auto-builds indexes.
 *
 * There is now one connection for the process. The console's four exclusive
 * collections (`admin_otps`, `admin_users`, `admin_notes`, `admin_audit`) lose
 * the accidental auto-indexing they relied on, so their indexes are declared
 * to `scripts/ensure-prod-indexes.ts` instead — run `npm run
 * ensure-indexes:prod` before cutover.
 */
export { connectMongo } from "@/server/db/mongoose";
