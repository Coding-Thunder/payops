import "server-only";

/**
 * Selection logic for the beta-account purge.
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE. `scripts/delete-beta-users.ts` was
 * an irreversible production operation with three properties that made it
 * unsafe to run and impossible to test:
 *
 *   1. NO TARGETING. It read every `beta_applications` row (`find({})`) and
 *      finished with `deleteMany({})` on that collection. "Delete these beta
 *      users" and "delete every beta record there has ever been" were the same
 *      command, and the second is not recoverable.
 *   2. ORPHANED IDENTITIES. It removed the Mongo rows and never touched
 *      Firebase, so a purged person's password kept working and their next
 *      sign-in hit the no-account refusal. That is the state that generated a
 *      production support report.
 *   3. PII IN LOGS. It printed every applicant's email address to stdout,
 *      which is where operator logs are aggregated and retained.
 *
 * The pure decision lives here so it can be tested without a database and
 * without the possibility of deleting anything — the same split
 * `firebase-backfill.ts` uses for the password migration.
 */

/** One candidate row, as the script reads it. */
export interface PurgeCandidate {
  id: string;
  email: string;
  status: string;
  /** Set once activation provisioned a User. */
  activatedUserId?: string | null;
}

export interface PurgeSelector {
  /** Explicit addresses to purge. Lower-cased and trimmed by `parseSelectors`. */
  emails: string[];
  /** Explicit application ids to purge. */
  ids: string[];
}

export type PurgeRefusal =
  | "no-selector"
  | "selector-matched-nothing";

export interface PurgePlan {
  /** Rows that will be deleted. Never the whole collection. */
  selected: PurgeCandidate[];
  /** Candidates deliberately left alone, with the reason. */
  skipped: Array<{ id: string; reason: "not-selected" }>;
  /**
   * Addresses whose Firebase identity must be removed by hand. The script does
   * NOT delete these: Firebase deletion is irreversible and has no dry run, so
   * it stays a human decision. Leaving them unreported is what created orphans.
   */
  firebaseIdentitiesToRemoveManually: string[];
  refusal: PurgeRefusal | null;
}

/** Normalise `--email=` / `--id=` arguments. Repeatable, comma-separated. */
export function parseSelectors(argv: readonly string[]): PurgeSelector {
  const emails: string[] = [];
  const ids: string[] = [];
  for (const arg of argv) {
    const email = /^--email=(.+)$/.exec(arg);
    if (email) {
      for (const part of email[1]!.split(",")) {
        const v = part.trim().toLowerCase();
        if (v) emails.push(v);
      }
      continue;
    }
    const id = /^--id=(.+)$/.exec(arg);
    if (id) {
      for (const part of id[1]!.split(",")) {
        const v = part.trim();
        if (v) ids.push(v);
      }
    }
  }
  return { emails, ids };
}

/**
 * Decide what a purge would touch.
 *
 * REFUSES on an empty selector. That is the central change: an operator must
 * name who they mean, so there is no spelling of this command that means
 * "everything". A typo now deletes nothing instead of deleting the collection.
 */
export function buildPurgePlan(
  candidates: readonly PurgeCandidate[],
  selector: PurgeSelector,
): PurgePlan {
  const wantEmail = new Set(selector.emails);
  const wantId = new Set(selector.ids);

  if (wantEmail.size === 0 && wantId.size === 0) {
    return {
      selected: [],
      skipped: [],
      firebaseIdentitiesToRemoveManually: [],
      refusal: "no-selector",
    };
  }

  const selected: PurgeCandidate[] = [];
  const skipped: Array<{ id: string; reason: "not-selected" }> = [];
  for (const c of candidates) {
    const match =
      wantEmail.has(c.email.trim().toLowerCase()) || wantId.has(c.id);
    if (match) selected.push(c);
    else skipped.push({ id: c.id, reason: "not-selected" });
  }

  return {
    selected,
    skipped,
    // Every selected row had, or may have had, a Firebase identity created for
    // it — activation provisions one via syncFirebasePassword, and a failed
    // signup can leave one behind even with no User row.
    firebaseIdentitiesToRemoveManually: selected.map((c) => c.email),
    refusal: selected.length === 0 ? "selector-matched-nothing" : null,
  };
}

/**
 * A one-line summary safe to print. Counts and ids only: an operator log is
 * not a place for applicant email addresses.
 */
export function describePlan(plan: PurgePlan): string {
  if (plan.refusal === "no-selector") {
    return "REFUSED: no --email= or --id= selector given. This command has no 'all' mode.";
  }
  if (plan.refusal === "selector-matched-nothing") {
    return "REFUSED: the selector matched no beta_applications row.";
  }
  return [
    `selected=${plan.selected.length}`,
    `skipped=${plan.skipped.length}`,
    `activated=${plan.selected.filter((c) => c.activatedUserId).length}`,
    `firebaseIdentitiesNeedingManualRemoval=${plan.firebaseIdentitiesToRemoveManually.length}`,
  ].join(" ");
}
