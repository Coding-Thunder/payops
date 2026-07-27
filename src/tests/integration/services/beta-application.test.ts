import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { BetaApplicationStatus, BetaUserType } from "@/lib/constants/beta";
import { ValidationError } from "@/lib/errors";
import { BetaApplication, Organization, User } from "@/server/db/models";
import {
  activateFromToken,
  getApplicationForActivation,
  hashBetaToken,
  submitApplication,
} from "@/server/services/beta-application.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

/** Seed an INVITED application with a fresh single-use token; returns the raw
 *  token (mirrors what the admin approve flow mints). */
async function seedInvited(
  overrides: {
    email?: string;
    expiresAt?: Date;
    usedAt?: Date | null;
    status?: BetaApplicationStatus;
    businessName?: string | null;
  } = {},
): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  await BetaApplication.create({
    fullName: "Priya Rao",
    email: overrides.email ?? "priya@vela.test",
    userType: BetaUserType.AGENCY_OWNER,
    businessName: overrides.businessName ?? "Vela Studio",
    status: overrides.status ?? BetaApplicationStatus.INVITED,
    invite: {
      tokenHash: hashBetaToken(raw),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
      sentAt: new Date(),
      usedAt: overrides.usedAt ?? null,
    },
  });
  return raw;
}

describe("submitApplication", () => {
  it("stores a PENDING application and creates no account", async () => {
    await submitApplication({
      fullName: "Ada Lovelace",
      email: "Ada@Acme.TEST",
      userType: BetaUserType.FREELANCER,
      businessName: "Acme",
      clientsManaged: "6–20",
      challengeAnswer: "Losing track of approvals.",
    });
    const app = await BetaApplication.findOne({ email: "ada@acme.test" }).lean();
    expect(app).toBeTruthy();
    expect(app!.status).toBe(BetaApplicationStatus.PENDING);
    expect(app!.fullName).toBe("Ada Lovelace");
    // No account provisioned by applying.
    expect(await User.countDocuments({})).toBe(0);
    expect(await Organization.countDocuments({})).toBe(0);
  });

  it("dedupes by email silently (one row, no throw)", async () => {
    const input = {
      fullName: "Ada",
      email: "dupe@acme.test",
      userType: BetaUserType.OTHER,
    };
    await submitApplication(input);
    await submitApplication({ ...input, fullName: "Someone Else" });
    const count = await BetaApplication.countDocuments({
      email: "dupe@acme.test",
    });
    expect(count).toBe(1);
    // First submission wins; the re-submit doesn't overwrite.
    const app = await BetaApplication.findOne({
      email: "dupe@acme.test",
    }).lean();
    expect(app!.fullName).toBe("Ada");
  });
});

describe("getApplicationForActivation", () => {
  it("returns the bound identity for a valid INVITED token", async () => {
    const raw = await seedInvited();
    const view = await getApplicationForActivation(raw);
    expect(view).not.toBeNull();
    expect(view!.email).toBe("priya@vela.test");
    expect(view!.businessName).toBe("Vela Studio");
  });

  it("rejects a wrong, expired, used, or non-INVITED token", async () => {
    expect(await getApplicationForActivation("not-a-real-token")).toBeNull();

    const expired = await seedInvited({
      email: "a@x.test",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getApplicationForActivation(expired)).toBeNull();

    const used = await seedInvited({
      email: "b@x.test",
      usedAt: new Date(),
    });
    expect(await getApplicationForActivation(used)).toBeNull();

    const pending = await seedInvited({
      email: "c@x.test",
      status: BetaApplicationStatus.PENDING,
    });
    expect(await getApplicationForActivation(pending)).toBeNull();
  });
});

describe("activateFromToken", () => {
  it("creates the workspace, marks ACTIVATED, and is single-use", async () => {
    const raw = await seedInvited({ email: "founder@vela.test" });

    const result = await activateFromToken(
      raw,
      { password: "Hunter2Hunter2" },
      null,
    );
    expect(result.user.email).toBe("founder@vela.test");
    expect(result.orgId).toBeTruthy();

    const app = await BetaApplication.findOne({
      email: "founder@vela.test",
    }).lean();
    expect(app!.status).toBe(BetaApplicationStatus.ACTIVATED);
    expect(app!.invite?.usedAt).toBeTruthy();
    expect(await User.countDocuments({ email: "founder@vela.test" })).toBe(1);

    // Single-use: the same token can't activate again.
    await expect(
      activateFromToken(raw, { password: "Hunter2Hunter2" }, null),
    ).rejects.toBeInstanceOf(ValidationError);
    // Still exactly one account.
    expect(await User.countDocuments({ email: "founder@vela.test" })).toBe(1);
  });

  it("rejects an expired token without creating an account", async () => {
    const raw = await seedInvited({
      email: "late@vela.test",
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      activateFromToken(raw, { password: "Hunter2Hunter2" }, null),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await User.countDocuments({ email: "late@vela.test" })).toBe(0);
  });
});
