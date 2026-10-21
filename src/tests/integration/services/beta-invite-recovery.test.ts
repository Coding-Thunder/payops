import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BetaApplicationStatus } from "@/lib/constants/beta";
import { BetaApplication } from "@/server/db/models";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * A stuck invitation must be recoverable, without becoming reusable.
 *
 * `activateFromToken` claims the invite by setting `invite.usedAt` BEFORE it
 * provisions, and releases the claim if provisioning throws. If the process
 * dies between those two points — or the release itself fails — the row is
 * left `INVITED` with `usedAt` set. The console's re-approve claim filter
 * matched only PENDING and APPROVED-with-error, so nothing matched that row:
 * the applicant's link was dead, and no operator action could revive it. For
 * a private beta whose ONLY account-creation path is this one, that is the
 * whole door.
 *
 * The fix adds one disjunct, floored at ten minutes. The floor is what keeps
 * single-use intact: an activation genuinely in flight holds a fresh claim and
 * cannot be re-minted out from under the applicant. And re-approving mints a
 * NEW token mailed to the APPLICATION's own address, so recovery reissues to
 * the same identity rather than handing the invitation to a different one.
 */

const ADMIN = "ops@tracetxn.test";
const STUCK_MS = 10 * 60 * 1000;

// The console guard reads an admin session; this suite drives the service
// directly, so the guard is satisfied explicitly rather than by forging one.
vi.mock("@/console/server/auth/session", () => ({
  assertConsoleAdmin: async () => ADMIN,
  getAdminEmail: async () => ADMIN,
}));

// The invite mail is a network side effect; the claim is what is under test.
// Rest parameter, so the forwarding wrapper below typechecks.
const sendInvite = vi.fn(async (..._a: unknown[]) => {
  void _a;
});
vi.mock("@/console/server/email/mailer", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sendBetaInvitationEmail: (...a: unknown[]) => sendInvite(...a) };
});

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  sendInvite.mockClear();
});

async function seed(
  status: BetaApplicationStatus,
  usedAt: Date | null,
  expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000),
) {
  return BetaApplication.create({
    fullName: "Stuck Applicant",
    email: "stuck@applicant.test",
    businessName: "Stuck Co",
    userType: "AGENCY_OWNER",
    status,
    invite: { tokenHash: "a".repeat(64), usedAt, expiresAt },
  });
}

async function approve(id: Types.ObjectId) {
  const { approveBetaApplication } = await import(
    "@/console/server/services/beta-applications"
  );
  return approveBetaApplication(String(id), ADMIN, "127.0.0.1");
}

describe("recovering a stuck invitation", () => {
  it("re-mints for an INVITED row whose claim is definitively abandoned", async () => {
    const app = await seed(BetaApplicationStatus.INVITED, new Date(Date.now() - STUCK_MS - 60_000));
    const before = (await BetaApplication.findById(app._id).lean())!;

    const res = await approve(app._id as Types.ObjectId);

    expect(res.emailed).toBe(true);
    const after = (await BetaApplication.findById(app._id).lean())!;
    // A NEW token, so the dead link cannot be reused and the live one is fresh.
    expect(after.invite?.tokenHash).not.toBe(before.invite?.tokenHash);
    expect(after.invite?.usedAt ?? null).toBeNull();
  });

  it("REFUSES a claim that may still be in flight", async () => {
    // Two minutes old: an activation could legitimately be mid-transaction,
    // and re-minting would snatch the invitation from under it.
    const app = await seed(BetaApplicationStatus.INVITED, new Date(Date.now() - 2 * 60_000));
    const before = (await BetaApplication.findById(app._id).lean())!;

    const res = await approve(app._id as Types.ObjectId);

    expect(res.emailed).toBe(false);
    const after = (await BetaApplication.findById(app._id).lean())!;
    expect(after.invite?.tokenHash).toBe(before.invite?.tokenHash);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it("REFUSES an INVITED row that was never claimed", async () => {
    // usedAt null means the link is still live and unused. Re-minting would
    // silently kill a link the applicant already holds — the regression the
    // original filter was written to prevent.
    const app = await seed(BetaApplicationStatus.INVITED, null);
    const before = (await BetaApplication.findById(app._id).lean())!;

    const res = await approve(app._id as Types.ObjectId);

    expect(res.emailed).toBe(false);
    const after = (await BetaApplication.findById(app._id).lean())!;
    expect(after.invite?.tokenHash).toBe(before.invite?.tokenHash);
  });

  it("REFUSES an ACTIVATED row, so a real account cannot be re-invited", async () => {
    const app = await seed(BetaApplicationStatus.ACTIVATED, new Date(Date.now() - STUCK_MS - 60_000));
    // This one throws rather than returning, which is the stronger answer: an
    // activated applicant has a live account, and reissuing an invitation for
    // it would be a mistake worth surfacing loudly.
    await expect(approve(app._id as Types.ObjectId)).rejects.toThrow(
      /already activated/i,
    );
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it("still handles the ordinary first approval", async () => {
    const app = await seed(BetaApplicationStatus.PENDING, null);
    const res = await approve(app._id as Types.ObjectId);
    expect(res.emailed).toBe(true);
    const after = (await BetaApplication.findById(app._id).lean())!;
    expect(after.status).toBe("INVITED");
  });
});
