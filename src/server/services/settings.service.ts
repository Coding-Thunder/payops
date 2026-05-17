import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  type BookingType,
  type Currency,
} from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { Setting, SETTINGS_KEY, type SettingDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { UpdateSettingsInput } from "@/lib/validation";

import { recordAudit } from "./audit.service";

export interface OperationalSettings {
  paymentExpiryHours: number;
  orderPrefix: string;
  allowedBookingTypes: BookingType[];
  defaultCurrency: Currency;
  supportEmail: string;
  supportPhone: string;
  successRedirectUrl: string;
  cancelRedirectUrl: string;
  updatedAt: string;
}

function toDTO(doc: SettingDoc | null): OperationalSettings {
  const e = env.server;
  if (!doc) {
    return {
      paymentExpiryHours: e.DEFAULT_PAYMENT_EXPIRY_HOURS,
      orderPrefix: e.DEFAULT_ORDER_PREFIX,
      allowedBookingTypes: ["NEW_BOOKING", "MODIFICATION", "CANCELLATION_CHARGE"],
      defaultCurrency: (e.DEFAULT_CURRENCY as Currency) || "USD",
      supportEmail: e.SUPPORT_EMAIL,
      supportPhone: e.SUPPORT_PHONE,
      successRedirectUrl: `${e.APP_URL}/orders/payment/success`,
      cancelRedirectUrl: `${e.APP_URL}/orders/payment/cancelled`,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    paymentExpiryHours: doc.paymentExpiryHours,
    orderPrefix: doc.orderPrefix,
    allowedBookingTypes: doc.allowedBookingTypes,
    defaultCurrency: doc.defaultCurrency,
    supportEmail: doc.supportEmail,
    supportPhone: doc.supportPhone,
    successRedirectUrl: doc.successRedirectUrl,
    cancelRedirectUrl: doc.cancelRedirectUrl,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function getSettings(): Promise<OperationalSettings> {
  await connectMongo();
  const doc = await Setting.findOne({ key: SETTINGS_KEY }).lean<SettingDoc>();
  return toDTO(doc);
}

interface UpdateSettingsContext {
  actorId: string;
  actorName: string;
  actorRole: "SUPER_ADMIN" | "ADMIN" | "STAFF";
  request?: { ip: string | null; userAgent: string | null; requestId: string | null } | null;
}

export async function ensureSettingsDocument(): Promise<SettingDoc> {
  await connectMongo();
  const e = env.server;
  const doc = await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $setOnInsert: {
        key: SETTINGS_KEY,
        paymentExpiryHours: e.DEFAULT_PAYMENT_EXPIRY_HOURS,
        orderPrefix: e.DEFAULT_ORDER_PREFIX,
        allowedBookingTypes: [
          "NEW_BOOKING",
          "MODIFICATION",
          "CANCELLATION_CHARGE",
        ],
        defaultCurrency: e.DEFAULT_CURRENCY,
        supportEmail: e.SUPPORT_EMAIL,
        supportPhone: e.SUPPORT_PHONE,
        successRedirectUrl: `${e.APP_URL}/orders/payment/success`,
        cancelRedirectUrl: `${e.APP_URL}/orders/payment/cancelled`,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<SettingDoc>();
  if (!doc) throw new Error("Failed to load settings document");
  return doc;
}

export async function updateSettings(
  input: UpdateSettingsInput,
  ctx: UpdateSettingsContext,
): Promise<OperationalSettings> {
  await ensureSettingsDocument();
  const updated = await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        ...input,
        updatedBy: new Types.ObjectId(ctx.actorId),
      },
    },
    { new: true },
  ).lean<SettingDoc>();
  if (!updated) throw new Error("Settings document missing after update");

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: SETTINGS_KEY,
    actor: {
      userId: ctx.actorId,
      name: ctx.actorName,
      role: ctx.actorRole,
    },
    request: ctx.request ?? null,
    metadata: { changes: input },
  });

  return toDTO(updated);
}
