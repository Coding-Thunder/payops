// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  classifyCandidate,
  firebaseUidFor,
  isBcryptHash,
  maskEmail,
  planBackfill,
  toImportRecord,
  type BackfillCandidate,
} from "@/server/auth/firebase-backfill";

/**
 * Selection logic for the one-off Firebase password backfill.
 *
 * This decides who gets an account created in a live auth provider using a
 * hash we hand over verbatim, so every branch is a safety property rather
 * than a preference:
 *
 *   - importing a NON-bcrypt string mints an account whose password nobody
 *     knows (Firebase trusts the hash);
 *   - importing over an EXISTING user overwrites them, because
 *     `importUsers` overwrites on uid collision;
 *   - importing a non-ACTIVE user resurrects an account that was closed.
 *
 * The two non-bcrypt shapes below are real rows from production, not
 * invented: `firebase:<uid>` is the sentinel `signup.service.ts:265` writes
 * for Firebase-provisioned users (9 of 16 rows), and the random hex
 * placeholder is what `user.service.ts` seeds for an unaccepted invite.
 */

/**
 * A genuine bcryptjs hash (cost 4, of a throwaway string) rather than a
 * hand-written lookalike — the first draft of this fixture was two
 * characters too long and silently failed every assertion, which is exactly
 * the class of mistake `isBcryptHash` exists to catch in production data.
 */
const REAL_BCRYPT =
  "$2b$04$3b.OcTmQ7ckNc1J4Z0ADSuipIfj7osw.Hp/r6NLI6IG6u.TcH./Rm";

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    id: "65f0000000000000000000a1",
    email: "ada@example.com",
    status: "ACTIVE",
    passwordHash: REAL_BCRYPT,
    existsInFirebase: false,
    uidTaken: false,
    ...over,
  };
}

describe("isBcryptHash", () => {
  it("accepts the hashes this codebase produces", () => {
    // hashPassword() emits $2b$ at cost 12.
    expect(isBcryptHash(REAL_BCRYPT)).toBe(true);
    expect(isBcryptHash(REAL_BCRYPT.replace("$2b$", "$2a$"))).toBe(true);
    expect(isBcryptHash(REAL_BCRYPT.replace("$2b$", "$2y$"))).toBe(true);
  });

  it("rejects the firebase: sentinel", () => {
    // signup.service.ts:265 — these users ALREADY have Firebase accounts.
    expect(isBcryptHash("firebase:AbCdEf1234567890AbCdEf1234")).toBe(false);
  });

  it("rejects the random placeholder seeded for an unaccepted invite", () => {
    expect(isBcryptHash("a".repeat(64))).toBe(false);
  });

  it("rejects near-misses that would still be handed to Firebase", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "$2c$12$" + "a".repeat(53), // unknown variant letter
      "$2b$12$" + "a".repeat(52), // one char short
      "$2b$12$" + "a".repeat(54), // one char long
      "$2b$1$" + "a".repeat(53), // single-digit cost
      " $2b$12$" + "a".repeat(53), // leading space
      REAL_BCRYPT + "\n", // trailing newline
    ]) {
      expect(isBcryptHash(bad as string), `${String(bad).slice(0, 12)}…`).toBe(
        false,
      );
    }
  });
});

describe("classifyCandidate", () => {
  it("selects an ACTIVE bcrypt user with no Firebase account", () => {
    expect(classifyCandidate(candidate())).toEqual({
      eligible: true,
      candidate: candidate(),
    });
  });

  it.each([
    ["not-active", { status: "DISABLED" }],
    ["not-active", { status: "ARCHIVED" }],
    ["no-password-hash", { passwordHash: null }],
    ["not-bcrypt", { passwordHash: "firebase:uid123" }],
    ["already-in-firebase", { existsInFirebase: true }],
    ["uid-taken", { uidTaken: true }],
  ])("skips with reason %s", (reason, over) => {
    const d = classifyCandidate(candidate(over as Partial<BackfillCandidate>));
    expect(d.eligible).toBe(false);
    expect(d.eligible === false && d.reason).toBe(reason);
  });

  it("never selects someone who already has a Firebase account, whatever else is true", () => {
    // The single most destructive mistake available: importUsers overwrites
    // on uid collision, so this check is what makes the run non-destructive.
    for (const over of [
      {},
      { status: "ACTIVE" },
      { passwordHash: REAL_BCRYPT },
      { uidTaken: false },
    ]) {
      const d = classifyCandidate(
        candidate({ ...over, existsInFirebase: true }),
      );
      expect(d.eligible).toBe(false);
    }
  });

  it("reports the most informative reason when several apply", () => {
    // A DISABLED user with a sentinel hash is reported as not-active: the
    // account state is the more useful fact for an operator.
    const d = classifyCandidate(
      candidate({ status: "DISABLED", passwordHash: "firebase:x" }),
    );
    expect(d.eligible === false && d.reason).toBe("not-active");
  });
});

describe("planBackfill", () => {
  /** The production population as measured: 16 users, 4 importable. */
  const population: BackfillCandidate[] = [
    ...Array.from({ length: 4 }, (_, i) =>
      candidate({ id: `eligible-${i}`, email: `e${i}@example.com` }),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      candidate({
        id: `fb-${i}`,
        email: `f${i}@example.com`,
        passwordHash: `firebase:uid-${i}`,
        existsInFirebase: true,
      }),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      candidate({
        id: `linked-${i}`,
        email: `l${i}@example.com`,
        existsInFirebase: true,
      }),
    ),
  ];

  it("counts every bucket and they sum to the total", () => {
    const p = planBackfill(population);
    expect(p.counts.total).toBe(16);
    expect(p.counts.eligible).toBe(4);
    expect(p.counts["already-in-firebase"]).toBe(3);
    expect(p.counts["not-bcrypt"]).toBe(9);
    const sum = Object.entries(p.counts)
      .filter(([k]) => k !== "total" && k !== "eligible")
      .reduce((a, [, n]) => a + n, 0);
    expect(sum + p.counts.eligible).toBe(p.counts.total);
  });

  it("returns eligible and skipped sets that partition the input", () => {
    const p = planBackfill(population);
    expect(p.eligible.length + p.skipped.length).toBe(population.length);
    const ids = new Set([
      ...p.eligible.map((c) => c.id),
      ...p.skipped.map((s) => s.candidate.id),
    ]);
    expect(ids.size).toBe(population.length);
  });

  it("is idempotent in effect: a second pass after import selects nobody", () => {
    // Model the re-run: everyone imported now exists in Firebase.
    const afterRun = population.map((c) =>
      c.id.startsWith("eligible") ? { ...c, existsInFirebase: true } : c,
    );
    expect(planBackfill(afterRun).counts.eligible).toBe(0);
  });

  it("handles an empty population", () => {
    const p = planBackfill([]);
    expect(p.counts.total).toBe(0);
    expect(p.eligible).toEqual([]);
  });
});

describe("toImportRecord", () => {
  it("carries the EXISTING hash through unchanged", () => {
    // The whole point: the user's current password keeps working. If this
    // ever transformed the hash, everyone would be locked out instead.
    const rec = toImportRecord(candidate());
    expect(rec.passwordHash.toString("utf8")).toBe(REAL_BCRYPT);
  });

  it("uses the Mongo id as the uid, so a re-run cannot duplicate", () => {
    const rec = toImportRecord(candidate({ id: "65f0000000000000000000ff" }));
    expect(rec.uid).toBe("65f0000000000000000000ff");
    expect(firebaseUidFor("abc")).toBe("abc");
  });

  it("sets emailVerified so the session exchange will link the identity", () => {
    // /api/auth/firebase-session refuses to link an unverified identity, so
    // omitting this yields a working password that cannot open a session.
    expect(toImportRecord(candidate()).emailVerified).toBe(true);
  });

  it("refuses a non-bcrypt hash rather than minting an unusable account", () => {
    expect(() =>
      toImportRecord(candidate({ passwordHash: "firebase:uid" })),
    ).toThrow(/non-bcrypt/i);
  });

  it("refuses a non-ACTIVE user", () => {
    expect(() => toImportRecord(candidate({ status: "DISABLED" }))).toThrow(
      /non-ACTIVE/i,
    );
  });

  it("never carries a plaintext password or any other field", () => {
    expect(Object.keys(toImportRecord(candidate())).sort()).toEqual([
      "email",
      "emailVerified",
      "passwordHash",
      "uid",
    ]);
  });
});

describe("maskEmail", () => {
  it("keeps the domain but hides the local part", () => {
    expect(maskEmail("ada@example.com")).toBe("a**@example.com");
    expect(maskEmail("a@example.com")).toBe("a**@example.com");
  });

  it("does not leak the local part length below three stars", () => {
    // A one-character mask would make short addresses guessable.
    expect(maskEmail("ab@x.io")).toBe("a**@x.io");
  });

  it("never returns the original address", () => {
    for (const e of ["ada@example.com", "very.long.name@corp.example"]) {
      expect(maskEmail(e)).not.toBe(e);
      expect(maskEmail(e)).not.toContain(e.split("@")[0].slice(1));
    }
  });

  it("degrades safely on malformed input", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@nolocal.com")).toBe("***");
  });
});
