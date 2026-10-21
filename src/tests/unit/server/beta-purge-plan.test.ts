import { describe, expect, it } from "vitest";

import {
  buildPurgePlan,
  describePlan,
  parseSelectors,
  type PurgeCandidate,
} from "@/server/ops/beta-purge-plan";

/**
 * The purge must never be able to mean "everything".
 *
 * `scripts/delete-beta-users.ts` read every `beta_applications` row with
 * `find({})` and finished with `deleteMany({})` on that collection, resolving
 * the user and organization deletes from the same unfiltered list. So "purge
 * these two testers" and "erase every beta record there has ever been" were
 * the same command — and the second is irreversible. It also printed every
 * applicant's email to stdout and never reported the Firebase identities it
 * left behind, which is the orphan state behind a real production report.
 *
 * These tests pin the decision, which is why it was extracted: a destructive
 * script cannot be exercised safely, but the choice of what to destroy can.
 */

const CANDIDATES: PurgeCandidate[] = [
  { id: "a1", email: "keep@example.test", status: "PENDING", activatedUserId: null },
  { id: "a2", email: "purge@example.test", status: "ACTIVATED", activatedUserId: "u2" },
  { id: "a3", email: "Also.Purge@Example.TEST", status: "INVITED", activatedUserId: null },
  { id: "a4", email: "untouched@example.test", status: "REJECTED", activatedUserId: null },
];

describe("parseSelectors", () => {
  it("accepts repeated and comma-separated selectors", () => {
    const s = parseSelectors([
      "--email=a@x.test,b@x.test",
      "--email=c@x.test",
      "--id=i1,i2",
      "--yes",
    ]);
    expect(s.emails).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
    expect(s.ids).toEqual(["i1", "i2"]);
  });

  it("lower-cases addresses, because the stored value is lower-cased", () => {
    expect(parseSelectors(["--email=  MiXeD@Example.TEST "]).emails).toEqual([
      "mixed@example.test",
    ]);
  });

  it("finds nothing in an argv that only says --yes", () => {
    const s = parseSelectors(["--yes"]);
    expect(s.emails).toEqual([]);
    expect(s.ids).toEqual([]);
  });
});

describe("buildPurgePlan", () => {
  it("REFUSES with no selector — there is no 'all' mode", () => {
    const plan = buildPurgePlan(CANDIDATES, { emails: [], ids: [] });
    expect(plan.refusal).toBe("no-selector");
    expect(plan.selected).toEqual([]);
    // The important half: a missing selector must not fall back to everything.
    expect(plan.selected.length).not.toBe(CANDIDATES.length);
  });

  it("REFUSES when a selector matches nothing, rather than deleting nothing quietly", () => {
    const plan = buildPurgePlan(CANDIDATES, {
      emails: ["nobody@example.test"],
      ids: [],
    });
    expect(plan.refusal).toBe("selector-matched-nothing");
    expect(plan.selected).toEqual([]);
  });

  it("selects only the named rows", () => {
    const plan = buildPurgePlan(CANDIDATES, {
      emails: ["purge@example.test"],
      ids: [],
    });
    expect(plan.refusal).toBeNull();
    expect(plan.selected.map((c) => c.id)).toEqual(["a2"]);
    expect(plan.skipped.map((c) => c.id).sort()).toEqual(["a1", "a3", "a4"]);
  });

  it("matches an address case-insensitively", () => {
    const plan = buildPurgePlan(CANDIDATES, {
      emails: ["also.purge@example.test"],
      ids: [],
    });
    expect(plan.selected.map((c) => c.id)).toEqual(["a3"]);
  });

  it("selects by id as well as address", () => {
    const plan = buildPurgePlan(CANDIDATES, { emails: [], ids: ["a1"] });
    expect(plan.selected.map((c) => c.id)).toEqual(["a1"]);
  });

  it("reports the Firebase identities it will NOT delete", () => {
    const plan = buildPurgePlan(CANDIDATES, {
      emails: ["purge@example.test"],
      ids: [],
    });
    // Firebase deletion has no dry run and no undo, so it stays a human
    // decision — but silence is what left purged users holding a working
    // password with no account.
    expect(plan.firebaseIdentitiesToRemoveManually).toEqual([
      "purge@example.test",
    ]);
  });

  it("never selects a row that was neither named nor matched", () => {
    for (const selector of [
      { emails: ["purge@example.test"], ids: [] },
      { emails: [], ids: ["a2"] },
      { emails: ["purge@example.test"], ids: ["a3"] },
    ]) {
      const plan = buildPurgePlan(CANDIDATES, selector);
      for (const c of plan.selected) {
        const named =
          selector.emails.includes(c.email.toLowerCase()) ||
          selector.ids.includes(c.id);
        expect(named, `${c.id} was selected without being named`).toBe(true);
      }
    }
  });
});

describe("describePlan", () => {
  it("explains a refusal in terms an operator can act on", () => {
    expect(describePlan(buildPurgePlan(CANDIDATES, { emails: [], ids: [] })))
      .toMatch(/no --email= or --id= selector/i);
  });

  it("prints counts, never an address", () => {
    const line = describePlan(
      buildPurgePlan(CANDIDATES, { emails: ["purge@example.test"], ids: [] }),
    );
    expect(line).toContain("selected=1");
    expect(line).toContain("firebaseIdentitiesNeedingManualRemoval=1");
    // Operator logs are aggregated and retained; addresses do not belong there.
    expect(line).not.toContain("@");
  });
});
