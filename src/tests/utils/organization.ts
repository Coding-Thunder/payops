import { PaymentGatewayKey, RecordState } from "@/lib/constants/enums";
import { Organization } from "@/server/db/models";
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
export const TEST_ORG_SLUG = "himanshu";

export async function seedTestOrganization(overrides: {
  enabledProviders?: PaymentGatewayKey[];
  provider?: PaymentGatewayKey;
} = {}): Promise<string> {
  await connectMongo();
  const doc = await Organization.findOneAndUpdate(
    { slug: TEST_ORG_SLUG },
    {
      $setOnInsert: {
        slug: TEST_ORG_SLUG,
        name: "Himanshu",
        brandName: "Himanshu",
        status: RecordState.ACTIVE,
        isDefault: true,
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
