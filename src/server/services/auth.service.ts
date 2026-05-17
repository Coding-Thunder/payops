import "server-only";

import {
  AuditAction,
  AuditEntity,
  RecordState,
} from "@/lib/constants/enums";
import { UnauthorizedError } from "@/lib/errors";
import { User, type UserDoc } from "@/server/db/models";
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
    "+passwordHash name email role status",
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

  const token = await signSession({
    sub: session.id,
    email: session.email,
    name: session.name,
    role: session.role,
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
