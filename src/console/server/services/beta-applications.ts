import "server-only";

import crypto from "node:crypto";

import { env } from "@/console/server/env";
import { connectMongo } from "@/console/server/db/mongoose";
import { BetaApplication, type BetaApplicationDoc } from "@/console/server/db/models";
import { recordAdminAction } from "@/console/server/audit";
import { normalizeEmail } from "@/console/server/auth/allowlist";
import { sendBetaInvitationEmail } from "@/console/server/email/mailer";
import { assertConsoleAdmin } from "@/console/server/auth/session";

/**
 * Beta Applications review — the admin side. Approving generates a
 * cryptographically-secure single-use invitation, stores only its sha256
 * hash, and emails the raw token as an activation link on the MAIN app.
 * Status only becomes INVITED after the email actually sends; a send failure
 * is recorded for retry. The raw token is never persisted or logged.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("base64url");
  return { raw, hash };
}

function escapeRegex(s: string): string {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function activationUrl(rawToken: string): string {
  const base = env.server.MAIN_APP_URL.replace(/\/$/, "");
  return `${base}/activate?token=${rawToken}`;
}

/** Attribution as the admin UI consumes it: every field present, nulls for
 *  what was not captured, so the view never has to guess. */
export interface BetaAppAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
  landingPage: string | null;
}

export interface BetaAppRow {
  id: string;
  fullName: string;
  email: string;
  userType: string;
  businessName: string | null;
  clientsManaged: string | null;
  challengeAnswer: string | null;
  status: string;
  adminNote: string | null;
  reviewedByEmail: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  inviteExpiresAt: string | null;
  lastInviteError: string | null;
  /** Null for a direct visit, and for every lead predating attribution. */
  attribution: BetaAppAttribution | null;
}

/**
 * Normalise the stored sub-document for display.
 *
 * The console reads this collection with `strict: false`, so the value is
 * whatever the database holds — including shapes written before the field
 * existed. Every field is coerced to `string | null` here so the view can
 * render it without type-guarding, and a row of all-nulls collapses to null
 * so "no attribution" and "empty attribution" look the same to the admin.
 *
 * Values originate from an anonymous visitor's browser. They are DISPLAY
 * DATA: never used in a query, a decision, or a link the admin can click.
 */
function toAttribution(
  raw: BetaApplicationDoc["attribution"],
): BetaAppAttribution | null {
  if (!raw || typeof raw !== "object") return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null;
  const out: BetaAppAttribution = {
    utmSource: str(raw.utmSource),
    utmMedium: str(raw.utmMedium),
    utmCampaign: str(raw.utmCampaign),
    utmTerm: str(raw.utmTerm),
    utmContent: str(raw.utmContent),
    referrer: str(raw.referrer),
    landingPage: str(raw.landingPage),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function toRow(d: BetaApplicationDoc): BetaAppRow {
  return {
    id: String(d._id),
    fullName: d.fullName,
    email: d.email,
    userType: d.userType,
    businessName: d.businessName ?? null,
    clientsManaged: d.clientsManaged ?? null,
    challengeAnswer: d.challengeAnswer ?? null,
    status: d.status,
    adminNote: d.adminNote ?? null,
    reviewedByEmail: d.reviewedByEmail ?? null,
    createdAt: d.createdAt ? d.createdAt.toISOString() : null,
    reviewedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
    invitedAt: d.invite?.sentAt ? d.invite.sentAt.toISOString() : null,
    activatedAt: d.activatedAt ? d.activatedAt.toISOString() : null,
    inviteExpiresAt: d.invite?.expiresAt
      ? d.invite.expiresAt.toISOString()
      : null,
    lastInviteError: d.lastInviteError ?? null,
    attribution: toAttribution(d.attribution),
  };
}

export interface ListBetaResult {
  items: BetaAppRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listBetaApplications(opts: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListBetaResult> {
  await assertConsoleAdmin();
  await connectMongo();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const filter: Record<string, unknown> = {};
  if (opts.status && opts.status !== "ALL") filter.status = opts.status;
  if (opts.search && opts.search.trim()) {
    const rx = new RegExp(escapeRegex(opts.search), "i");
    filter.$or = [{ fullName: rx }, { email: rx }, { businessName: rx }];
  }
  const [docs, total] = await Promise.all([
    BetaApplication.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<BetaApplicationDoc[]>(),
    BetaApplication.countDocuments(filter),
  ]);
  return {
    items: docs.map(toRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getBetaApplication(
  id: string,
): Promise<BetaAppRow | null> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const doc = await BetaApplication.findById(id).lean<BetaApplicationDoc>();
  return doc ? toRow(doc) : null;
}

export async function countPendingApplications(): Promise<number> {
  await assertConsoleAdmin();
  await connectMongo();
  return BetaApplication.countDocuments({ status: "PENDING" });
}

/**
 * Approve (or re-send an invite for) an application: mint a fresh single-use
 * token, store its hash, and email the activation link. Status becomes
 * INVITED only on a successful send; otherwise it stays APPROVED with the
 * error recorded for retry. Doubles as the retry action.
 */
export async function approveBetaApplication(
  id: string,
  actorEmail: string,
  ip: string | null,
): Promise<{ status: string; emailed: boolean; error: string | null }> {
  await assertConsoleAdmin();
  await connectMongo();

  const { raw, hash } = generateInviteToken();
  const now = new Date();
  const invite = {
    tokenHash: hash,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    sentAt: null,
    usedAt: null,
  };

  // Atomically CLAIM the right to send. Exactly one caller can win, because
  // the filter only matches a state the claim itself destroys:
  //   - a first approval matches PENDING, and the claim sets APPROVED;
  //   - a retry of a failed send matches APPROVED with a non-null
  //     lastInviteError, and the claim clears that error.
  // A second concurrent call therefore matches neither. Previously this was a
  // read-modify-write with no guard on INVITED at all, so approving twice
  // minted a second token and emailed it — silently killing the first link the
  // applicant had already received.
  const claimed = await BetaApplication.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: "PENDING" },
        { status: "APPROVED", lastInviteError: { $ne: null } },
      ],
    },
    {
      $set: {
        status: "APPROVED",
        invite,
        reviewedByEmail: normalizeEmail(actorEmail),
        reviewedAt: now,
        lastInviteError: null,
      },
    },
    { returnDocument: "after" },
  ).lean<BetaApplicationDoc | null>();

  if (!claimed) {
    // We did not win the claim. Report the current state without sending.
    const current = await BetaApplication.findById(id).lean<BetaApplicationDoc | null>();
    if (!current) throw new Error("Application not found");
    if (current.status === "ACTIVATED") {
      throw new Error("This applicant has already activated their account.");
    }
    if (current.status === "REJECTED") {
      throw new Error("This application was rejected and can't be approved.");
    }
    // INVITED (already sent) or APPROVED mid-send by a concurrent request.
    // Idempotent no-op: no second email, existing invite left intact.
    return { status: current.status, emailed: false, error: null };
  }

  await recordAdminAction({
    action: "beta.approve",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "beta_application",
    targetId: String(claimed._id),
    metadata: { email: claimed.email },
    ip,
  });

  try {
    await sendBetaInvitationEmail({
      to: claimed.email,
      name: claimed.fullName,
      url: activationUrl(raw),
    });
    await BetaApplication.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: "INVITED",
          invite: { ...invite, sentAt: new Date() },
          lastInviteError: null,
        },
      },
    );
    await recordAdminAction({
      action: "beta.invited",
      actorEmail: normalizeEmail(actorEmail),
      targetType: "beta_application",
      targetId: String(claimed._id),
      ip,
    });
    return { status: "INVITED", emailed: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 500) : "Email send failed";
    // Leaves status APPROVED with lastInviteError set — which is exactly the
    // state the claim filter treats as retryable.
    await BetaApplication.updateOne(
      { _id: claimed._id },
      { $set: { lastInviteError: message } },
    );
    await recordAdminAction({
      action: "beta.invite_failed",
      actorEmail: normalizeEmail(actorEmail),
      targetType: "beta_application",
      targetId: String(claimed._id),
      metadata: { error: message },
      ip,
    });
    return { status: "APPROVED", emailed: false, error: message };
  }
}

export async function rejectBetaApplication(
  id: string,
  actorEmail: string,
  note: string | undefined,
  ip: string | null,
): Promise<void> {
  await assertConsoleAdmin();
  await connectMongo();
  const app = await BetaApplication.findById(id);
  if (!app) throw new Error("Application not found");
  if (app.status === "ACTIVATED") {
    throw new Error("This applicant has already activated their account.");
  }
  app.status = "REJECTED";
  app.invite = null; // revoke any outstanding invitation
  app.reviewedByEmail = normalizeEmail(actorEmail);
  app.reviewedAt = new Date();
  if (note !== undefined) app.adminNote = note.trim() || null;
  await app.save();
  await recordAdminAction({
    action: "beta.reject",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "beta_application",
    targetId: String(app._id),
    ip,
  });
}

export async function setBetaAdminNote(
  id: string,
  note: string,
  actorEmail: string,
  ip: string | null,
): Promise<void> {
  await assertConsoleAdmin();
  await connectMongo();
  const app = await BetaApplication.findById(id);
  if (!app) throw new Error("Application not found");
  app.adminNote = note.trim() || null;
  await app.save();
  await recordAdminAction({
    action: "beta.note",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "beta_application",
    targetId: String(app._id),
    ip,
  });
}
