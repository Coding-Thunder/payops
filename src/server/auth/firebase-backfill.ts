import "server-only";

/**
 * Selection logic for the one-off Firebase password backfill.
 *
 * WHY THIS EXISTS. `/login` renders `FirebaseAuthForm` and authenticates
 * only against Firebase Auth, but the migration to Firebase was never
 * backfilled. `syncFirebasePassword` (see `./firebase-password`) fixed every
 * FUTURE password write; users who existed before it and have not changed
 * their password since still hold nothing but a bcrypt hash in Mongo, and
 * their correct password is rejected on every attempt.
 *
 * The repair is Firebase's documented bcrypt import: hand Firebase the
 * EXISTING hash so the user's current password keeps working. Nothing is
 * reset, no mail is sent, and no password is ever generated — which is what
 * makes this safe to run without telling anyone.
 *
 * The pure decision lives here, apart from `scripts/migrate-firebase-passwords.ts`,
 * so it can be tested without a database or a Firebase project. Every skip
 * reason below corresponds to a real row shape observed in production.
 */

/** Why a user was left alone. Ordered by how the classifier checks them. */
export type BackfillSkipReason =
  | "not-active"
  | "no-password-hash"
  | "not-bcrypt"
  | "already-in-firebase"
  | "uid-taken";

export interface BackfillCandidate {
  /** Mongo `_id`, reused verbatim as the Firebase uid — see `firebaseUidFor`. */
  id: string;
  email: string;
  status: string;
  passwordHash?: string | null;
  /** Whether a Firebase account already exists for this email. */
  existsInFirebase: boolean;
  /** Whether the derived uid is already taken by a DIFFERENT Firebase user. */
  uidTaken?: boolean;
}

export type BackfillDecision =
  | { eligible: true; candidate: BackfillCandidate }
  | { eligible: false; candidate: BackfillCandidate; reason: BackfillSkipReason };

/**
 * A real bcrypt hash, and nothing else.
 *
 * This is the load-bearing check. Firebase's BCRYPT importer takes the hash
 * at its word, so feeding it anything else mints an account whose password
 * nobody knows. Two shapes in this database are NOT bcrypt and must never be
 * imported:
 *
 *   - `firebase:<uid>` — the sentinel `signup.service.ts` writes for users
 *     provisioned THROUGH Firebase, who by definition already have an
 *     account (9 of 16 production rows, all of them already linked).
 *   - the unguessable random hex placeholder `user.service.ts` seeds for an
 *     invited member who has not accepted yet. Those rows are DISABLED and
 *     already excluded, but the format check is the honest guard.
 *
 * `$2a$` / `$2b$` / `$2y$` are the standard prefixes; this codebase's
 * `hashPassword` emits `$2b$` at cost 12. A bcrypt hash is exactly 60 chars.
 */
export function isBcryptHash(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

/**
 * The Firebase uid for a Mongo user: the Mongo `_id`, unchanged.
 *
 * Deterministic on purpose. Re-running the migration derives the same uid,
 * so a half-finished run cannot produce a second Firebase account for the
 * same person, and the uid is trivially traceable back to its Mongo row
 * during an incident.
 */
export function firebaseUidFor(mongoId: string): string {
  return mongoId;
}

/**
 * Redact an address for console output. The script prints one line per user,
 * and a migration log should never become a mailing list.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, local.length - 1))}@${domain}`;
}

/**
 * Decide one user. Order matters: the cheapest, most decisive checks first,
 * so the reported reason is the most informative one rather than whichever
 * happened to be evaluated.
 */
export function classifyCandidate(c: BackfillCandidate): BackfillDecision {
  if (c.status !== "ACTIVE") {
    return { eligible: false, candidate: c, reason: "not-active" };
  }
  if (!c.passwordHash) {
    return { eligible: false, candidate: c, reason: "no-password-hash" };
  }
  if (!isBcryptHash(c.passwordHash)) {
    return { eligible: false, candidate: c, reason: "not-bcrypt" };
  }
  // The instruction that matters most: never touch someone who already has
  // an account. `importUsers` overwrites on uid collision, so this check —
  // not the importer — is what makes the run non-destructive.
  if (c.existsInFirebase) {
    return { eligible: false, candidate: c, reason: "already-in-firebase" };
  }
  if (c.uidTaken) {
    return { eligible: false, candidate: c, reason: "uid-taken" };
  }
  return { eligible: true, candidate: c };
}

export interface BackfillPlan {
  eligible: BackfillCandidate[];
  skipped: { candidate: BackfillCandidate; reason: BackfillSkipReason }[];
  counts: Record<BackfillSkipReason | "eligible" | "total", number>;
}

/** Classify a whole population and tally it. */
export function planBackfill(candidates: BackfillCandidate[]): BackfillPlan {
  const eligible: BackfillCandidate[] = [];
  const skipped: BackfillPlan["skipped"] = [];
  const counts: BackfillPlan["counts"] = {
    total: candidates.length,
    eligible: 0,
    "not-active": 0,
    "no-password-hash": 0,
    "not-bcrypt": 0,
    "already-in-firebase": 0,
    "uid-taken": 0,
  };

  for (const c of candidates) {
    const decision = classifyCandidate(c);
    if (decision.eligible) {
      eligible.push(c);
      counts.eligible += 1;
    } else {
      skipped.push({ candidate: c, reason: decision.reason });
      counts[decision.reason] += 1;
    }
  }
  return { eligible, skipped, counts };
}

/** The exact record shape handed to `auth.importUsers()`. */
export interface FirebaseImportRecord {
  uid: string;
  email: string;
  emailVerified: boolean;
  passwordHash: Buffer;
}

/**
 * Build one import record.
 *
 * `emailVerified: true` mirrors `syncFirebasePassword`, and is sound for the
 * same reason: only ACTIVE users reach here, and an ACTIVE row means the
 * address already proved itself through signup, activation or an emailed
 * invite. It also matters functionally — `/api/auth/firebase-session` refuses
 * to link an unverified identity, so importing without it would produce a
 * working Firebase password that still cannot open a session.
 *
 * Throws rather than coerces: a non-bcrypt hash reaching this point is a bug
 * in the caller, and the failure mode (an account nobody can sign into) is
 * silent and hard to reverse.
 */
export function toImportRecord(c: BackfillCandidate): FirebaseImportRecord {
  if (c.status !== "ACTIVE") {
    throw new Error("Refusing to import a non-ACTIVE user");
  }
  if (!isBcryptHash(c.passwordHash)) {
    throw new Error("Refusing to import a non-bcrypt password hash");
  }
  return {
    uid: firebaseUidFor(c.id),
    email: c.email,
    emailVerified: true,
    // Firebase takes the bcrypt hash as raw bytes; the cost and salt are
    // encoded in the string itself, so no rounds/salt options are needed.
    passwordHash: Buffer.from(c.passwordHash as string, "utf8"),
  };
}
