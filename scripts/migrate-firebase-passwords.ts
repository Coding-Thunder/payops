/**
 * One-off migration: give pre-Firebase users a Firebase Auth account that
 * keeps their EXISTING password.
 *
 * WHY. `/login` renders `FirebaseAuthForm` and authenticates only against
 * Firebase Auth. `syncFirebasePassword` fixed every future password write,
 * but nobody backfilled the users who already existed — they still hold only
 * a bcrypt hash in Mongo, so their correct password is rejected every time.
 * This hands Firebase that same hash through its documented BCRYPT importer,
 * so the password they already know starts working. Nothing is reset, no mail
 * is sent, no password is generated, and no Google identity is created.
 *
 * SAFETY MODEL
 *   - DRY RUN IS THE DEFAULT. Writes happen only with an explicit --apply.
 *   - Only ACTIVE users with a real bcrypt hash and NO existing Firebase
 *     account are touched. `importUsers` overwrites on uid collision, so that
 *     existence check — not the importer — is what keeps this non-destructive.
 *   - Idempotent: a re-run sees the account it created and skips it. The uid
 *     is the Mongo _id, so a half-finished run cannot mint a duplicate.
 *   - Never prints a password hash, a token, a service account, or a full
 *     email address.
 *
 * USAGE
 *   # dry run against local env (default — writes nothing)
 *   npx tsx --require ./scripts/shim-server-only.cjs scripts/migrate-firebase-passwords.ts
 *
 *   # dry run against production (read-only)
 *   npm run migrate:firebase-passwords:prod
 *
 *   # perform the import
 *   npm run migrate:firebase-passwords:prod -- --apply
 *
 * FLAGS
 *   --apply     perform writes. Without it the script only reports.
 *   --limit N   cap how many users are imported in this run (default: all).
 *   --verbose   list skipped users too, not just eligible ones.
 */

import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { User } from "@/server/db/models";
import { connectMongo, disconnectMongo } from "@/server/db/mongoose";
import {
  maskEmail,
  planBackfill,
  toImportRecord,
  type BackfillCandidate,
} from "@/server/auth/firebase-backfill";

/** Firebase caps importUsers at 1000 records per call; stay well under it. */
const IMPORT_BATCH_SIZE = 100;

interface Flags {
  apply: boolean;
  limit: number | null;
  verbose: boolean;
}

function parseFlags(argv: string[]): Flags {
  const apply = argv.includes("--apply");
  const verbose = argv.includes("--verbose");
  const limitArg = argv.find((a) => a.startsWith("--limit"));
  let limit: number | null = null;
  if (limitArg) {
    const raw = limitArg.includes("=")
      ? limitArg.split("=")[1]
      : argv[argv.indexOf(limitArg) + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit needs a positive integer, got: ${String(raw)}`);
    }
    limit = n;
  }
  return { apply, limit, verbose };
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  console.log("Firebase password backfill");
  console.log(
    `  mode: ${flags.apply ? "APPLY (writes will be performed)" : "DRY RUN (default — nothing will be modified)"}`,
  );
  if (flags.limit) console.log(`  limit: ${flags.limit}`);
  console.log();

  const auth = getFirebaseAdminAuth();
  if (!auth) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT is unset or unparseable — cannot reach Firebase Admin. Nothing was changed.",
    );
    return 2;
  }

  await connectMongo();

  // `passwordHash` is `select: false` on the model, so ask for it explicitly.
  const rows = await User.find({})
    .select("+passwordHash email status")
    .lean<{ _id: unknown; email: string; status: string; passwordHash?: string }[]>();

  console.log(`Read ${rows.length} users from Mongo. Checking Firebase…`);

  // Ask Firebase about each address. Done per-user rather than via a bulk
  // list so the answer is authoritative for exactly the email we will import
  // under, including any that Firebase normalises differently.
  const candidates: BackfillCandidate[] = [];
  for (const r of rows) {
    const id = String(r._id);
    let existsInFirebase = false;
    let uidTaken = false;
    try {
      await auth.getUserByEmail(r.email);
      existsInFirebase = true;
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== "auth/user-not-found") {
        // A transport or permission failure must NOT be read as "no account
        // exists" — that would import over a live user. Treat it as present
        // so the row is skipped, and say so.
        console.error(
          `  ! could not check Firebase for ${maskEmail(r.email)} — skipping this user. ${
            (err as Error)?.message ?? String(err)
          }`,
        );
        existsInFirebase = true;
      }
    }
    if (!existsInFirebase) {
      // Defensive: the uid is the Mongo _id, so a collision means a previous
      // partial run already imported this person under a different email.
      try {
        await auth.getUser(id);
        uidTaken = true;
      } catch {
        uidTaken = false;
      }
    }
    candidates.push({
      id,
      email: r.email,
      status: r.status,
      passwordHash: r.passwordHash ?? null,
      existsInFirebase,
      uidTaken,
    });
  }

  const plan = planBackfill(candidates);

  console.log("\nSelection");
  console.log(`  total users ................ ${plan.counts.total}`);
  console.log(`  ELIGIBLE for import ........ ${plan.counts.eligible}`);
  console.log(`  skipped: already in Firebase ${plan.counts["already-in-firebase"]}`);
  console.log(`  skipped: not ACTIVE ........ ${plan.counts["not-active"]}`);
  console.log(`  skipped: hash not bcrypt ... ${plan.counts["not-bcrypt"]}`);
  console.log(`  skipped: no password hash .. ${plan.counts["no-password-hash"]}`);
  console.log(`  skipped: uid already taken . ${plan.counts["uid-taken"]}`);

  if (plan.eligible.length > 0) {
    console.log("\nEligible users (masked):");
    for (const c of plan.eligible) {
      console.log(`  ${c.id}  ${maskEmail(c.email)}`);
    }
  }
  if (flags.verbose && plan.skipped.length > 0) {
    console.log("\nSkipped users (masked):");
    for (const s of plan.skipped) {
      console.log(
        `  ${s.candidate.id}  ${maskEmail(s.candidate.email)}  — ${s.reason}`,
      );
    }
  }

  const selected = flags.limit
    ? plan.eligible.slice(0, flags.limit)
    : plan.eligible;

  if (!flags.apply) {
    console.log(
      `\nDRY RUN — nothing was modified. ${selected.length} user(s) would be imported.`,
    );
    console.log("Re-run with --apply to perform the import.");
    await disconnectMongo();
    return 0;
  }

  if (selected.length === 0) {
    console.log("\nNothing to do.");
    await disconnectMongo();
    return 0;
  }

  console.log(`\nAPPLY — importing ${selected.length} user(s)…`);
  let imported = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i += IMPORT_BATCH_SIZE) {
    const batch = selected.slice(i, i + IMPORT_BATCH_SIZE);
    const records = batch.map(toImportRecord);
    try {
      const result = await auth.importUsers(records, {
        // The hash string carries its own cost and salt, so BCRYPT needs no
        // further options. Firebase verifies against it on next sign-in.
        hash: { algorithm: "BCRYPT" },
      });
      imported += result.successCount;
      failed += result.failureCount;
      // Per-record failures do NOT abort the batch; Firebase reports them by
      // index. Report each against a masked identity so a partial failure is
      // actionable without a second query.
      for (const e of result.errors) {
        const who = batch[e.index];
        console.error(
          `  ! import failed for ${who ? `${who.id} ${maskEmail(who.email)}` : `index ${e.index}`}: ${e.error.message}`,
        );
      }
    } catch (err) {
      // A whole-batch failure (auth, quota, network). Later batches are still
      // attempted: every record is independent and the run is idempotent.
      failed += batch.length;
      console.error(
        `  ! batch ${i / IMPORT_BATCH_SIZE + 1} failed entirely: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
  }

  console.log("\nResult");
  console.log(`  imported ... ${imported}`);
  console.log(`  failed ..... ${failed}`);
  console.log(
    "\nMongo was not modified. Imported users keep their existing password;" +
      "\n/api/auth/firebase-session links the new uid on their first sign-in.",
  );
  if (failed > 0) {
    console.log(
      "Re-running is safe: users imported successfully are skipped on the next pass.",
    );
  }

  await disconnectMongo();
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error("Migration aborted:", (err as Error)?.message ?? String(err));
    await disconnectMongo().catch(() => {});
    process.exit(1);
  });
