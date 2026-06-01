import { Types } from "mongoose";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { hashPassword } from "@/server/auth/password";
import { User, type UserDoc, type UserDocument } from "@/server/db/models";

/**
 * User factory.
 *
 *   - `buildUser()` , pure object (no DB write). For unit tests.
 *   - `createUser()`, persists a hashed user. For integration tests.
 *
 * `password` is hashed lazily so unit tests that never touch bcrypt don't
 * pay the ~250ms cost.
 */

export interface UserSeed extends Partial<UserDoc> {
  password?: string;
}

const DEFAULT_PASSWORD = "TestPass123!";

let counter = 0;
function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function buildUser(seed: UserSeed = {}): UserDoc & { _id: Types.ObjectId } {
  const suffix = uniqueSuffix();
  return {
    _id: new Types.ObjectId(),
    name: seed.name ?? `Test User ${suffix}`,
    email: (seed.email ?? `user-${suffix}@tracetxn.test`).toLowerCase(),
    passwordHash: seed.passwordHash ?? "$2b$12$placeholder.hash.value.for.test.only.do.not.use",
    role: seed.role ?? UserRole.STAFF,
    status: seed.status ?? RecordState.ACTIVE,
    createdBy: seed.createdBy ?? null,
    lastLoginAt: seed.lastLoginAt ?? null,
    createdAt: seed.createdAt ?? new Date(),
    updatedAt: seed.updatedAt ?? new Date(),
  };
}

export interface CreateUserOptions extends UserSeed {
  password?: string;
}

export async function createUser(
  opts: CreateUserOptions = {},
): Promise<UserDocument & { plainPassword: string }> {
  const plainPassword = opts.password ?? DEFAULT_PASSWORD;
  const passwordHash = opts.passwordHash ?? (await hashPassword(plainPassword));
  const seed = buildUser({ ...opts, passwordHash });
  const doc = (await User.create({
    _id: seed._id,
    name: seed.name,
    email: seed.email,
    passwordHash: seed.passwordHash,
    role: seed.role,
    status: seed.status,
    createdBy: seed.createdBy ?? undefined,
    lastLoginAt: seed.lastLoginAt ?? undefined,
  })) as UserDocument;
  return Object.assign(doc, { plainPassword });
}

export async function createAdmin(
  opts: CreateUserOptions = {},
): Promise<UserDocument & { plainPassword: string }> {
  return createUser({ role: UserRole.ADMIN, ...opts });
}

export async function createSuperAdmin(
  opts: CreateUserOptions = {},
): Promise<UserDocument & { plainPassword: string }> {
  return createUser({ role: UserRole.SUPER_ADMIN, ...opts });
}

export async function createStaff(
  opts: CreateUserOptions = {},
): Promise<UserDocument & { plainPassword: string }> {
  return createUser({ role: UserRole.STAFF, ...opts });
}
