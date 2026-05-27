import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  type ConsentMode,
  type Currency,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  Setting,
  SETTINGS_KEY,
  type SettingDoc,
} from "@/server/db/models";
import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_CONSENT_MESSAGE,
} from "@/server/db/models/setting.model";
import { connectMongo } from "@/server/db/mongoose";
import { loadScopedSingleton } from "@/server/db/org/scoped-singleton";
import { orgIdFilter } from "@/server/db/org/org-context";
import type { UpdateSettingsInput } from "@/lib/validation";

import { recordAudit } from "./audit.service";

export interface OperationalSettings {
  paymentExpiryHours: number;
  orderPrefix: string;
  defaultCurrency: Currency;
  successRedirectUrl: string;
  cancelRedirectUrl: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
  consentMode: ConsentMode;
  consentMessage: string;
  updatedAt: string;
}

function toDTO(doc: SettingDoc | null): OperationalSettings {
  const e = env.server;
  if (!doc) {
    return {
      paymentExpiryHours: e.DEFAULT_PAYMENT_EXPIRY_HOURS,
      orderPrefix: e.DEFAULT_ORDER_PREFIX,
      defaultCurrency: (e.DEFAULT_CURRENCY as Currency) || "USD",
      successRedirectUrl: `${e.APP_URL}/pay/success`,
      cancelRedirectUrl: `${e.APP_URL}/pay/cancelled`,
      cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
      cancellationPolicyVersion: "v1",
      consentMode: "ADVISORY",
      consentMessage: DEFAULT_CONSENT_MESSAGE,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    paymentExpiryHours: doc.paymentExpiryHours,
    orderPrefix: doc.orderPrefix,
    defaultCurrency: doc.defaultCurrency,
    // Redirect URLs are always derived from APP_URL so deploys / domain
    // changes propagate without a settings migration.
    successRedirectUrl: `${e.APP_URL}/pay/success`,
    cancelRedirectUrl: `${e.APP_URL}/pay/cancelled`,
    cancellationPolicy: doc.cancellationPolicy ?? DEFAULT_CANCELLATION_POLICY,
    cancellationPolicyVersion: doc.cancellationPolicyVersion ?? "v1",
    consentMode: doc.consentMode ?? "ADVISORY",
    consentMessage: doc.consentMessage ?? DEFAULT_CONSENT_MESSAGE,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Read the operational settings for an org. When `orgId` is omitted the
 * legacy `{ key: "default" }` singleton is returned — keeps untouched
 * callers working through the multi-tenant migration window. When an
 * `orgId` is supplied we resolve the per-org row, lazy-provisioning it
 * by cloning the legacy singleton on first access.
 */
export async function getSettings(
  orgId?: string | null,
): Promise<OperationalSettings> {
  await connectMongo();
  const doc = await loadScopedSingleton<SettingDoc>(Setting, {
    orgId,
    legacyKeyField: "key",
    legacyKeyValue: SETTINGS_KEY,
    seedFor: (legacy) => seedSettingsFields(legacy),
  });
  return toDTO(doc);
}

interface UpdateSettingsContext {
  actorId: string;
  actorName: string;
  actorRole: "SUPER_ADMIN" | "ADMIN" | "STAFF";
  /** Active organization. Optional only because some legacy admin
   *  callers haven't been migrated yet — when supplied, the update
   *  lands on the per-org row (lazy-provisioned on first write). */
  orgId?: string | null;
  request?: { ip: string | null; userAgent: string | null; requestId: string | null } | null;
}

/** Build the seed payload used by `loadScopedSingleton` to clone the
 *  legacy `{key:"default"}` row (or env defaults when none) into a
 *  fresh per-org row. MUST NOT include `key`. */
function seedSettingsFields(
  legacy: Pick<
    SettingDoc,
    | "paymentExpiryHours"
    | "orderPrefix"
    | "defaultCurrency"
    | "successRedirectUrl"
    | "cancelRedirectUrl"
    | "cancellationPolicy"
    | "cancellationPolicyVersion"
    | "consentMode"
    | "consentMessage"
  > | null,
): Record<string, unknown> {
  const e = env.server;
  return {
    paymentExpiryHours:
      legacy?.paymentExpiryHours ?? e.DEFAULT_PAYMENT_EXPIRY_HOURS,
    orderPrefix: legacy?.orderPrefix ?? e.DEFAULT_ORDER_PREFIX,
    defaultCurrency: legacy?.defaultCurrency ?? e.DEFAULT_CURRENCY,
    successRedirectUrl:
      legacy?.successRedirectUrl ?? `${e.APP_URL}/pay/success`,
    cancelRedirectUrl: legacy?.cancelRedirectUrl ?? `${e.APP_URL}/pay/cancelled`,
    cancellationPolicy:
      legacy?.cancellationPolicy ?? DEFAULT_CANCELLATION_POLICY,
    cancellationPolicyVersion: legacy?.cancellationPolicyVersion ?? "v1",
    consentMode: legacy?.consentMode ?? "ADVISORY",
    consentMessage: legacy?.consentMessage ?? DEFAULT_CONSENT_MESSAGE,
  };
}

export async function ensureSettingsDocument(
  orgId?: string | null,
): Promise<SettingDoc> {
  await connectMongo();
  // Per-org path: load (lazy-provisioning if needed) via the scoped
  // singleton helper so we use the same concurrency-safe insert path
  // as `getSettings`.
  if (orgId) {
    const doc = await loadScopedSingleton<SettingDoc>(Setting, {
      orgId,
      legacyKeyField: "key",
      legacyKeyValue: SETTINGS_KEY,
      seedFor: (legacy) => seedSettingsFields(legacy),
    });
    if (!doc) throw new Error("Failed to load settings document for org");
    return doc;
  }
  // Legacy path — preserved verbatim for back-compat callers.
  const e = env.server;
  const doc = await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $setOnInsert: {
        key: SETTINGS_KEY,
        paymentExpiryHours: e.DEFAULT_PAYMENT_EXPIRY_HOURS,
        orderPrefix: e.DEFAULT_ORDER_PREFIX,
        defaultCurrency: e.DEFAULT_CURRENCY,
        successRedirectUrl: `${e.APP_URL}/pay/success`,
        cancelRedirectUrl: `${e.APP_URL}/pay/cancelled`,
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).lean<SettingDoc>();
  if (!doc) throw new Error("Failed to load settings document");
  return doc;
}

export async function updateSettings(
  input: UpdateSettingsInput,
  ctx: UpdateSettingsContext,
): Promise<OperationalSettings> {
  const existing = await ensureSettingsDocument(ctx.orgId ?? null);

  // Compute the actual diff so the audit row only carries fields that
  // really changed (rather than the whole submitted body). Mirrors the
  // pattern in user.service.updateUser.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const set: Record<string, unknown> = {};

  const fields: Array<keyof UpdateSettingsInput> = [
    "paymentExpiryHours",
    "orderPrefix",
    "defaultCurrency",
    "successRedirectUrl",
    "cancelRedirectUrl",
    "cancellationPolicy",
    "consentMode",
    "consentMessage",
  ];
  for (const field of fields) {
    if (!(field in input)) continue;
    const next = input[field];
    const prev = existing[field as keyof SettingDoc];
    if (!isEqual(prev, next)) {
      changes[field] = { from: prev, to: next };
      set[field] = next;
    }
  }

  if (Object.keys(set).length === 0) {
    throw new ValidationError("No changes to apply");
  }

  set.updatedBy = new Types.ObjectId(ctx.actorId);

  // Auto-bump the policy version when the policy text changes. Old orders
  // keep their snapshot pointing at the old version string.
  if ("cancellationPolicy" in changes) {
    const bumped = nextPolicyVersion(existing.cancellationPolicyVersion ?? "v1");
    set.cancellationPolicyVersion = bumped;
    changes.cancellationPolicyVersion = {
      from: existing.cancellationPolicyVersion ?? "v1",
      to: bumped,
    };
  }

  // Target the per-org row when ctx carries an orgId; otherwise update
  // the legacy singleton. The filter is mutually exclusive with the
  // partial-unique on `orgId`, so updates can never cross-tenant.
  const updateFilter = ctx.orgId
    ? { orgId: orgIdFilter(ctx.orgId) }
    : { key: SETTINGS_KEY };
  const updated = await Setting.findOneAndUpdate(
    updateFilter,
    { $set: set },
    { returnDocument: "after" },
  ).lean<SettingDoc>();
  if (!updated) throw new Error("Settings document missing after update");

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: ctx.orgId ?? SETTINGS_KEY,
    orgId: ctx.orgId ?? null,
    actor: {
      userId: ctx.actorId,
      name: ctx.actorName,
      role: ctx.actorRole,
    },
    request: ctx.request ?? null,
    metadata: { changes },
  });

  return toDTO(updated);
}

/** Structural equality good enough for primitive fields + sorted arrays of
 *  primitives. Order-sensitive on arrays (intentional — booking-type order
 *  shouldn't matter today, but we surface re-ordering as a change anyway). */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  return false;
}

/** "v3" → "v4". Falls back to "v1" if the previous label isn't parseable. */
function nextPolicyVersion(current: string): string {
  const match = current.match(/^v(\d+)$/i);
  const n = match ? Number(match[1]) : 0;
  return `v${(Number.isFinite(n) && n > 0 ? n : 1) + 1}`;
}
