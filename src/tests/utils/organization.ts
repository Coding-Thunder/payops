import {
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Types } from "mongoose";

import { Organization, OrganizationMember } from "@/server/db/models";
import { _resetOrganizationCacheForTests } from "@/server/auth/organization";
import { connectMongo } from "@/server/db/mongoose";

/**
 * The one organization this deployment serves.
 *
 * Seeded before every integration test because that is the only state the
 * application ever runs in — there is no "before the organization exists"
 * mode any more, and `getOrganization` throws rather than pretending there
 * is. Mirrors what `scripts/seed-organizations.ts` writes, including the
 * explicit `enabledProviders`, so a test can never pass against a shape the
 * seed would not produce.
 */
export const TEST_ORG_SLUG = "rcrcruise";

export async function seedTestOrganization(overrides: {
  enabledProviders?: PaymentGatewayKey[];
  provider?: PaymentGatewayKey;
  /**
   * What this organization sells. DEFAULTS TO `[CAR_RENTAL]` — the schema
   * default — so every test written before service types existed keeps
   * creating the rental orders it always did. A flight or cruise test opts
   * in explicitly, which is also what proves the allow-list is real: those
   * tests fail if the seed is not widened.
   */
  serviceTypes?: ServiceType[];
} = {}): Promise<string> {
  await connectMongo();
  const doc = await Organization.findOneAndUpdate(
    { slug: TEST_ORG_SLUG },
    {
      $setOnInsert: {
        slug: TEST_ORG_SLUG,
        name: "RCR Cruise",
        brandName: "RCR Cruise",
        status: RecordState.ACTIVE,
        isDefault: true,
        serviceTypes: overrides.serviceTypes ?? [ServiceType.CAR_RENTAL],
        payments: {
          provider: overrides.provider ?? PaymentGatewayKey.STRIPE,
          enabledProviders: overrides.enabledProviders ?? [
            PaymentGatewayKey.STRIPE,
          ],
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<{ _id: unknown }>();

  // The resolver memoises; a test that reseeds with different providers must
  // see the new document rather than the previous one.
  _resetOrganizationCacheForTests();
  return String(doc._id);
}

/** Switch the seeded organization's enabled providers mid-test. */
export async function setEnabledProviders(
  enabled: PaymentGatewayKey[],
  provider: PaymentGatewayKey = enabled[0] ?? PaymentGatewayKey.STRIPE,
): Promise<void> {
  await connectMongo();
  await Organization.updateOne(
    { slug: TEST_ORG_SLUG },
    { $set: { "payments.enabledProviders": enabled, "payments.provider": provider } },
  );
  _resetOrganizationCacheForTests();
}

/**
 * Widen (or narrow) what the seeded organization sells, mid-test.
 *
 * Separate from `seedTestOrganization` because that upserts with
 * `$setOnInsert` — deliberately, so it mirrors the real seed script — and a
 * second call therefore cannot change an existing document. A test that
 * needs the flight tab has to say so with a real update.
 */
export async function setOrganizationServiceTypes(
  serviceTypes: ServiceType[],
): Promise<void> {
  await connectMongo();
  await Organization.updateOne(
    { slug: TEST_ORG_SLUG },
    { $set: { serviceTypes } },
  );
  _resetOrganizationCacheForTests();
}

/**
 * Seed an ADDITIONAL organization alongside the default one.
 *
 * Models the real production shape: Himanshu holds `isDefault` and its
 * pre-migration history; RCR Cruise is a second tenant that must never see
 * any of it.
 */
export async function seedSecondOrganization(opts: {
  slug: string;
  brandName?: string;
  serviceTypes?: ServiceType[];
  enabledProviders?: PaymentGatewayKey[];
  appUrl?: string;
  emailCc?: string;
}): Promise<string> {
  await connectMongo();
  const doc = await Organization.findOneAndUpdate(
    { slug: opts.slug },
    {
      $setOnInsert: {
        slug: opts.slug,
        name: opts.brandName ?? opts.slug,
        brandName: opts.brandName ?? opts.slug,
        status: RecordState.ACTIVE,
        // NEVER the anchor — a second tenant that claimed it would inherit
        // the incumbent's unattributed history.
        isDefault: false,
        serviceTypes: opts.serviceTypes ?? [ServiceType.CAR_RENTAL],
        appUrl: opts.appUrl ?? "",
        email: { cc: opts.emailCc ?? "" },
        payments: {
          provider: PaymentGatewayKey.STRIPE,
          enabledProviders: opts.enabledProviders ?? [PaymentGatewayKey.STRIPE],
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<{ _id: unknown }>();
  return String(doc._id);
}

/** Give a user an ACTIVE membership of an organization. */
export async function addMembership(
  organizationId: string,
  userId: string,
  role: UserRole = UserRole.ADMIN,
): Promise<void> {
  await connectMongo();
  await OrganizationMember.updateOne(
    {
      organizationId: new Types.ObjectId(organizationId),
      userId: new Types.ObjectId(userId),
    },
    {
      $set: {
        organizationId: new Types.ObjectId(organizationId),
        userId: new Types.ObjectId(userId),
        role,
        status: RecordState.ACTIVE,
      },
    },
    { upsert: true },
  );
}

/** Revoke access without destroying the audit trail. */
export async function disableMembership(
  organizationId: string,
  userId: string,
): Promise<void> {
  await connectMongo();
  await OrganizationMember.updateOne(
    {
      organizationId: new Types.ObjectId(organizationId),
      userId: new Types.ObjectId(userId),
    },
    { $set: { status: RecordState.DISABLED } },
  );
}
