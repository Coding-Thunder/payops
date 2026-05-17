import {
  BOOKING_TYPES,
  Currency,
  type BookingType,
} from "@/lib/constants/enums";
import {
  DEFAULT_CANCELLATION_POLICY,
  Setting,
  SETTINGS_KEY,
  type SettingDoc,
  type SettingDocument,
} from "@/server/db/models/setting.model";

/**
 * Settings factory. There is only ever one settings document
 * (`key: "default"`); the factory upserts it so tests can call it
 * repeatedly without unique-key errors.
 */

export type SettingsSeed = Partial<SettingDoc>;

export function buildSettings(seed: SettingsSeed = {}): SettingDoc {
  const now = new Date();
  return {
    key: SETTINGS_KEY,
    paymentExpiryHours: seed.paymentExpiryHours ?? 24,
    orderPrefix: seed.orderPrefix ?? "TST",
    allowedBookingTypes:
      seed.allowedBookingTypes ?? ([...BOOKING_TYPES] as BookingType[]),
    defaultCurrency: (seed.defaultCurrency ?? Currency.USD) as Currency,
    supportEmail: seed.supportEmail ?? "support@payops.test",
    supportPhone: seed.supportPhone ?? "+15555550100",
    successRedirectUrl:
      seed.successRedirectUrl ?? "http://localhost:3000/pay/success",
    cancelRedirectUrl:
      seed.cancelRedirectUrl ?? "http://localhost:3000/pay/cancelled",
    cancellationPolicy: seed.cancellationPolicy ?? DEFAULT_CANCELLATION_POLICY,
    cancellationPolicyVersion: seed.cancellationPolicyVersion ?? "v1",
    updatedBy: seed.updatedBy ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

export async function createSettings(
  seed: SettingsSeed = {},
): Promise<SettingDocument> {
  const data = buildSettings(seed);
  const doc = await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        paymentExpiryHours: data.paymentExpiryHours,
        orderPrefix: data.orderPrefix,
        allowedBookingTypes: data.allowedBookingTypes,
        defaultCurrency: data.defaultCurrency,
        supportEmail: data.supportEmail,
        supportPhone: data.supportPhone,
        successRedirectUrl: data.successRedirectUrl,
        cancelRedirectUrl: data.cancelRedirectUrl,
        cancellationPolicy: data.cancellationPolicy,
        cancellationPolicyVersion: data.cancellationPolicyVersion,
        updatedBy: data.updatedBy ?? undefined,
      },
      $setOnInsert: { key: SETTINGS_KEY },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (!doc) throw new Error("Failed to upsert settings document");
  return doc as SettingDocument;
}
