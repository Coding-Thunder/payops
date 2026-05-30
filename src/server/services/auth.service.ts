import "server-only";

import {
  AuditAction,
  AuditEntity,
  RecordState,
} from "@/lib/constants/enums";
import { UnauthorizedError } from "@/lib/errors";
import { OrgMember, User, type UserDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { LoginInput } from "@/lib/validation";

import { recordAudit } from "./audit.service";
import { touchLastLogin } from "./user.service";
import { verifyPassword } from "@/server/auth/password";
import { signSession } from "@/server/auth/jwt";
import type { RequestContext } from "@/server/api/request-context";
import type { SessionUser } from "@/types";

interface AuthenticateResult {
  token: string;
  user: SessionUser;
}

export async function authenticate(
  input: LoginInput,
  ctx?: RequestContext | null,
): Promise<AuthenticateResult> {
  await connectMongo();
  const email = input.email.toLowerCase().trim();

  const user = await User.findOne({ email }).select(
    "+passwordHash name email role status primaryOrgId",
  );
  const passwordOk = user
    ? await verifyPassword(input.password, user.passwordHash)
    : false;

  if (!user || !passwordOk || user.status !== RecordState.ACTIVE) {
    await recordAudit({
      action: AuditAction.USER_LOGIN_FAILED,
      entityType: AuditEntity.USER,
      entityId: user ? String(user._id) : null,
      actor: user
        ? {
            userId: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role,
          }
        : { email, name: null, role: null, userId: null },
      request: ctx ?? null,
      metadata: {
        reason: !user
          ? "user_not_found"
          : !passwordOk
            ? "bad_password"
            : `status_${user.status}`,
      },
    });
    throw new UnauthorizedError("Invalid email or password");
  }

  const session: SessionUser = {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
  };

  // Resolve the user's active org for the new token. Order of precedence:
  //   1. `User.primaryOrgId` — set by the migration script and by future
  //      signup. The authoritative pointer.
  //   2. First ACTIVE OrgMember row — defensive fallback for accounts
  //      created before the migration script populated primaryOrgId.
  //   3. None — caller has no org. The token is still issued (no orgId
  //      claim); downstream callers will hit `requireOrgUser` and bounce
  //      the operator to a "contact support" path.
  //
  // We deliberately do NOT fail-closed on a missing org here — that
  // would lock the legacy super-admin out of their own console during
  // the migration window. Fail-closed lands once the migration is
  // verified and `primaryOrgId` becomes required on User.
  let activeOrgId: string | null = user.primaryOrgId
    ? String(user.primaryOrgId)
    : null;
  let orgIds: string[] = [];
  const memberships = await OrgMember.find({
    userId: user._id,
    status: RecordState.ACTIVE,
  })
    .select({ orgId: 1 })
    .lean<{ orgId: unknown }[]>();
  orgIds = memberships.map((m) => String(m.orgId));
  if (!activeOrgId && orgIds.length > 0) {
    activeOrgId = orgIds[0]!;
  }

  const token = await signSession({
    sub: session.id,
    email: session.email,
    name: session.name,
    role: session.role,
    orgId: activeOrgId ?? undefined,
    orgIds: orgIds.length > 0 ? orgIds : undefined,
  });

  await touchLastLogin(session.id);

  await recordAudit({
    action: AuditAction.USER_LOGIN,
    entityType: AuditEntity.USER,
    entityId: session.id,
    actor: {
      userId: session.id,
      name: session.name,
      email: session.email,
      role: session.role,
    },
    request: ctx ?? null,
  });

  return { token, user: session };
}

export async function recordLogout(
  user: SessionUser,
  ctx?: RequestContext | null,
): Promise<void> {
  await recordAudit({
    action: AuditAction.USER_LOGOUT,
    entityType: AuditEntity.USER,
    entityId: user.id,
    actor: {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    request: ctx ?? null,
  });
}

export function publicUserFromDoc(doc: UserDoc & { _id: unknown }): SessionUser {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role: doc.role,
  };
}

/* ─────────────────────── Firebase ID-token exchange ─────────────────────── */

export interface FirebaseExchangeInput {
  /** Lower-cased email from the verified Firebase ID token. */
  email: string;
  /** Optional display name — used when this is the user's first sign-in
   *  and we have to provision a User row + Organization. Falls back to
   *  the local-part of the email. */
  displayName?: string | null;
  /** Stable Firebase UID. Stored on the User as `externalAuth.firebaseUid`
   *  so future sign-ins of the same Firebase account always resolve to
   *  the same Mongo User, even if the email is later changed in Firebase. */
  firebaseUid: string;
}

export interface FirebaseExchangeResult extends AuthenticateResult {
  isNewUser: boolean;
  orgId: string | null;
}

/**
 * Mint a TraceTxn session from a Firebase ID token that the API route
 * has already verified. The route is the trust boundary; this helper
 * never re-verifies the token, it just trusts the (email, uid, name)
 * tuple.
 *
 * Lookup precedence:
 *   1. User with this `externalAuth.firebaseUid` — fastest path; lets
 *      the user's email change in Firebase without orphaning the row.
 *   2. User with this email — covers legacy users who pre-date Firebase
 *      auth. The row is linked back by stamping `externalAuth.firebaseUid`
 *      on first match.
 *   3. None — provision a new User + Organization (auto-named from the
 *      display name or email local-part) and return with isNewUser=true.
 *
 * The Firebase-only User path stores a placeholder passwordHash so the
 * Mongoose schema validates; bcrypt's `verifyPassword` will refuse the
 * sentinel value, so the legacy bcrypt login path can never authenticate
 * a Firebase-only user by accident.
 */
export async function firebaseExchange(
  input: FirebaseExchangeInput,
  ctx?: RequestContext | null,
): Promise<FirebaseExchangeResult> {
  await connectMongo();
  const email = input.email.toLowerCase().trim();
  if (!email) throw new UnauthorizedError("Missing email on Firebase token");

  // Try by firebaseUid first (handles email-change-in-Firebase case),
  // then fall back to email (handles legacy users + first link).
  let user = await User.findOne({
    "externalAuth.firebaseUid": input.firebaseUid,
  }).select(
    "+passwordHash name email role status primaryOrgId externalAuth",
  );
  let isNewUser = false;

  if (!user) {
    user = await User.findOne({ email }).select(
      "+passwordHash name email role status primaryOrgId externalAuth",
    );
    if (user) {
      // Link the legacy / pre-Firebase user to this Firebase UID so the
      // fast path hits on next sign-in.
      await User.updateOne(
        { _id: user._id },
        { $set: { "externalAuth.firebaseUid": input.firebaseUid } },
      );
    }
  }

  if (!user) {
    // First-time Firebase sign-in for this email → provision a User +
    // Organization. Delegates to the founder-signup path so we get the
    // same atomic tenant-creation guarantees.
    const { signupFounderFromFirebase } = await import("./signup.service");
    const provisional = await signupFounderFromFirebase(
      {
        email,
        name:
          (input.displayName ?? "").trim() ||
          email.split("@")[0] ||
          "New user",
        firebaseUid: input.firebaseUid,
      },
      ctx ?? null,
    );
    isNewUser = true;
    user = await User.findById(provisional.user.id).select(
      "+passwordHash name email role status primaryOrgId externalAuth",
    );
    if (!user) {
      throw new UnauthorizedError("Failed to provision Firebase user");
    }
  }

  if (user.status !== RecordState.ACTIVE) {
    await recordAudit({
      action: AuditAction.USER_LOGIN_FAILED,
      entityType: AuditEntity.USER,
      entityId: String(user._id),
      actor: {
        userId: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      request: ctx ?? null,
      metadata: { reason: `status_${user.status}`, source: "firebase" },
    });
    throw new UnauthorizedError("Account is not active");
  }

  // Mirror the JWT-resolution path from authenticate() so downstream
  // consumers see the same session shape regardless of which front-door
  // the user came through.
  let activeOrgId: string | null = user.primaryOrgId
    ? String(user.primaryOrgId)
    : null;
  const memberships = await OrgMember.find({
    userId: user._id,
    status: RecordState.ACTIVE,
  })
    .select({ orgId: 1 })
    .lean<{ orgId: unknown }[]>();
  const orgIds = memberships.map((m) => String(m.orgId));
  if (!activeOrgId && orgIds.length > 0) activeOrgId = orgIds[0]!;

  const session: SessionUser = {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
  };
  const token = await signSession({
    sub: session.id,
    email: session.email,
    name: session.name,
    role: session.role,
    orgId: activeOrgId ?? undefined,
    orgIds: orgIds.length > 0 ? orgIds : undefined,
  });

  await touchLastLogin(session.id);
  await recordAudit({
    action: AuditAction.USER_LOGIN,
    entityType: AuditEntity.USER,
    entityId: session.id,
    actor: {
      userId: session.id,
      name: session.name,
      email: session.email,
      role: session.role,
    },
    request: ctx ?? null,
    metadata: { source: "firebase", isNewUser },
  });

  return { token, user: session, isNewUser, orgId: activeOrgId };
}
