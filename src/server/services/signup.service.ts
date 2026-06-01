import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { ConflictError } from "@/lib/errors";
import {
  ORG_SLUG_REGEX,
  Organization,
  OrgMember,
  OrgStatus,
  User,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { sessionOpt, withTx } from "@/server/db/transaction";
import { hashPassword } from "@/server/auth/password";
import type { SignupInput } from "@/lib/validation";
import type { RequestContext } from "@/server/api/request-context";
import type { SessionUser } from "@/types";

import { recordAudit } from "./audit.service";

/**
 * Public signup result. Caller (`POST /api/auth/signup`) issues a JWT
 * + sets the session cookie + redirects to /app/dashboard, mirroring
 * the login response so the client side handles both identically.
 */
export interface SignupResult {
  user: SessionUser;
  orgId: string;
  orgSlug: string;
}

/**
 * Founder-onboarding flow. Atomically creates an Organization +
 * SUPER_ADMIN User + OrgMember row inside one Mongo transaction -
 * either all three land or none do, so a half-built tenant never
 * persists.
 *
 * Org status starts ACTIVE so the founder can use the product
 * immediately. Email verification (PENDING → ACTIVE transition) is
 * tracked here for future enforcement: `User.verifiedAt` is left null
 * so a future Phase-4b pass can require it before payout-relevant
 * actions without a data migration.
 */
export async function signupFounder(
  input: SignupInput,
  ctx: RequestContext | null,
): Promise<SignupResult> {
  await connectMongo();
  const email = input.email.trim().toLowerCase();

  // Pre-flight email uniqueness check OUTSIDE the transaction. The
  // unique index on `User.email` is the authoritative guard, this
  // check just returns a friendly error before we hash a bcrypt
  // (~250ms per attempt). The race window between check + insert is
  // safely covered by the unique index throwing E11000 on collision.
  const existing = await User.findOne({ email })
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  if (existing) {
    // Same response regardless of whether the email exists, avoids
    // a user-enumeration oracle the way the login route does.
    throw new ConflictError(
      "An account with that email may already exist. Try signing in instead.",
    );
  }

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueOrgSlug(input.orgName);

  const result = await withTx(async (session) => {
    // 1. User first, Org needs `ownerUserId` to point at a real row.
    const [userDoc] = await User.create(
      [
        {
          name: input.name,
          email,
          passwordHash,
          role: UserRole.SUPER_ADMIN,
          status: RecordState.ACTIVE,
        },
      ],
      sessionOpt(session),
    );
    const userId = userDoc._id as Types.ObjectId;

    // 2. Org with this user as owner. Starts ACTIVE, no email
    //    verification gate today, but `verifiedAt` is set to `null`
    //    so a future enforcement pass can require it.
    const [orgDoc] = await Organization.create(
      [
        {
          slug,
          name: input.orgName.trim(),
          ownerUserId: userId,
          status: OrgStatus.ACTIVE,
          verifiedAt: null,
          // Stamp the trial clock at signup so the billing gate
          // doesn't fall back to createdAt. Future migrations that
          // touch createdAt (e.g. anonymisation) won't reset the trial.
          trialStartsAt: new Date(),
        },
      ],
      sessionOpt(session),
    );
    const orgId = orgDoc._id as Types.ObjectId;

    // 3. OrgMember binding so the standard auth lookup path
    //    (`User.primaryOrgId` + OrgMember.find by userId) returns
    //    this row for the JWT-resolution step.
    await OrgMember.create(
      [
        {
          orgId,
          userId,
          role: UserRole.SUPER_ADMIN,
          status: RecordState.ACTIVE,
          joinedAt: new Date(),
        },
      ],
      sessionOpt(session),
    );

    // 4. Stamp the User's primaryOrgId so future logins resolve
    //    without an extra OrgMember query in the hot path.
    await User.updateOne(
      { _id: userId },
      { $set: { primaryOrgId: orgId } },
      sessionOpt(session),
    );

    // 5. Audit row. This is the canonical "tenant onboarded" record -
    //    useful for funnel analysis once self-serve volume picks up.
    await recordAudit(
      {
        action: AuditAction.USER_CREATED,
        entityType: AuditEntity.USER,
        entityId: String(userId),
        orgId: String(orgId),
        actor: {
          userId: String(userId),
          name: userDoc.name,
          email: userDoc.email,
          role: UserRole.SUPER_ADMIN,
        },
        request: ctx ?? null,
        metadata: {
          source: "signup",
          orgSlug: slug,
          orgName: orgDoc.name,
        },
      },
      session,
    );

    return {
      user: {
        id: String(userId),
        name: userDoc.name,
        email: userDoc.email,
        role: userDoc.role,
      },
      orgId: String(orgId),
      orgSlug: slug,
    };
  });

  return result;
}

/* ─────────────────────── Firebase-first signup ──────────────────────────── */

export interface FirebaseSignupInput {
  email: string;
  name: string;
  firebaseUid: string;
}

/**
 * Atomic founder-onboarding for a user arriving via Firebase Auth.
 * Same tenant-shape as signupFounder (Org + SUPER_ADMIN User +
 * OrgMember + primaryOrgId stamp) but skips the bcrypt password, the
 * Firebase UID is the credential, stored on `externalAuth.firebaseUid`.
 *
 * `passwordHash` gets a sentinel ("firebase:<uid>") to satisfy the
 * required-field schema constraint. The bcrypt `verifyPassword` will
 * never accept it as a valid hash, so the legacy bcrypt sign-in path
 * can never authenticate a Firebase-only user by accident.
 *
 * The org name is synthesized from the user's display name or email
 * local-part, the user can rename it later in /admin/settings.
 */
export async function signupFounderFromFirebase(
  input: FirebaseSignupInput,
  ctx: RequestContext | null,
): Promise<SignupResult> {
  await connectMongo();
  const email = input.email.trim().toLowerCase();

  // Race-safe email check, the unique index is authoritative.
  const existing = await User.findOne({ email })
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  if (existing) {
    throw new ConflictError(
      "An account with that email already exists. Sign in instead.",
    );
  }

  const synthOrgName = `${input.name.trim() || email.split("@")[0]}'s workspace`;
  const slug = await uniqueOrgSlug(synthOrgName);

  const result = await withTx(async (session) => {
    const [userDoc] = await User.create(
      [
        {
          name: input.name.trim(),
          email,
          // Sentinel; bcrypt.compare will reject it, so the legacy
          // login route can never authenticate this user.
          passwordHash: `firebase:${input.firebaseUid}`,
          role: UserRole.SUPER_ADMIN,
          status: RecordState.ACTIVE,
          externalAuth: { firebaseUid: input.firebaseUid },
        },
      ],
      sessionOpt(session),
    );
    const userId = userDoc._id as Types.ObjectId;

    const [orgDoc] = await Organization.create(
      [
        {
          slug,
          name: synthOrgName,
          ownerUserId: userId,
          status: OrgStatus.ACTIVE,
          verifiedAt: null,
          // Stamp the trial clock at signup so the billing gate
          // doesn't fall back to createdAt. Future migrations that
          // touch createdAt (e.g. anonymisation) won't reset the trial.
          trialStartsAt: new Date(),
        },
      ],
      sessionOpt(session),
    );
    const orgId = orgDoc._id as Types.ObjectId;

    await OrgMember.create(
      [
        {
          orgId,
          userId,
          role: UserRole.SUPER_ADMIN,
          status: RecordState.ACTIVE,
          joinedAt: new Date(),
        },
      ],
      sessionOpt(session),
    );

    await User.updateOne(
      { _id: userId },
      { $set: { primaryOrgId: orgId } },
      sessionOpt(session),
    );

    await recordAudit(
      {
        action: AuditAction.USER_CREATED,
        entityType: AuditEntity.USER,
        entityId: String(userId),
        orgId: String(orgId),
        actor: {
          userId: String(userId),
          name: userDoc.name,
          email: userDoc.email,
          role: UserRole.SUPER_ADMIN,
        },
        request: ctx ?? null,
        metadata: {
          source: "signup_firebase",
          orgSlug: slug,
          orgName: orgDoc.name,
          firebaseUid: input.firebaseUid,
        },
      },
      session,
    );

    return {
      user: {
        id: String(userId),
        name: userDoc.name,
        email: userDoc.email,
        role: userDoc.role,
      },
      orgId: String(orgId),
      orgSlug: slug,
    };
  });

  return result;
}

/* ───────────────────────────── Slug helpers ───────────────────────────── */

/**
 * Build a unique, URL-safe slug from a free-form org name. Iterates
 * with a `-2`, `-3`, … suffix on collision. Bounded retry: bails after
 * 50 attempts and throws, a user trying to register the 51st
 * "Acme Inc" should pick a more specific name.
 */
async function uniqueOrgSlug(name: string): Promise<string> {
  const base = slugify(name);
  if (await isSlugAvailable(base)) return base;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (await isSlugAvailable(candidate)) return candidate;
  }
  throw new ConflictError(
    "That business name is in heavy use. Please choose a more specific name.",
  );
}

/**
 * Slugs reserved for platform / brand / routing safety. Signup never
 * mints any of these, `uniqueOrgSlug` treats them as "taken" so the
 * suffix loop produces e.g. "admin-2" instead. A future operator can
 * still seed a legitimate org with a reserved slug via the migration
 * script (which bypasses signup).
 *
 * Three categories:
 *   - app routing keywords (admin, api, app, …)
 *   - TraceTxn brand (and the legacy PayOps name) + the legacy tenant key
 *   - generic trademark / abuse magnets (microsoft, google, …)
 *
 * Kept conservative, adding more is cheap, removing one mid-flight
 * doesn't break anything that's already registered.
 */
const RESERVED_SLUGS = new Set<string>([
  // Routing keywords / future URL segments.
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "console",
  "dashboard",
  "docs",
  "help",
  "login",
  "logout",
  "marketing",
  "payments",
  "pay",
  "platform",
  "settings",
  "signup",
  "static",
  "status",
  "support",
  "system",
  "www",
  // Platform brand, both the current and the legacy name stay
  // reserved so neither can be registered as an org slug.
  "tracetxn",
  "payops",
  // Legacy tenant slug, reserved so a future signup never collides.
  "legacy",
  // Common big-brand squat targets, block at registration so a
  // pre-launch abuse wave doesn't park them.
  "amazon",
  "apple",
  "facebook",
  "google",
  "meta",
  "microsoft",
  "netflix",
  "openai",
  "stripe",
  "twitter",
  "x",
]);

async function isSlugAvailable(slug: string): Promise<boolean> {
  if (!ORG_SLUG_REGEX.test(slug)) return false;
  if (RESERVED_SLUGS.has(slug)) return false;
  const existing = await Organization.exists({ slug });
  return !existing;
}

/**
 * Normalize an arbitrary string to the slug shape the Organization
 * schema accepts: `[a-z][a-z0-9-]{1,31}`.
 *
 *   - lowercases
 *   - replaces runs of non-alnum with `-`
 *   - strips leading / trailing hyphens
 *   - prefixes a letter if the first char is a digit (regex requires
 *     `[a-z]` at position 0)
 *   - falls back to "org" if the input strips to empty
 *   - clips to 28 chars to leave room for a `-NN` suffix
 *
 * Exported for tests; service-layer callers should prefer
 * `uniqueOrgSlug` so collisions get resolved.
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "org";
  if (/^[0-9]/.test(slug)) slug = `o-${slug}`;
  return slug.slice(0, 28);
}
