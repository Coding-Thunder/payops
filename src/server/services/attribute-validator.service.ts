import "server-only";

import { Types } from "mongoose";

import { ItemAttributeType } from "@/lib/constants/items";
import { ValidationError } from "@/lib/errors";
import {
  ItemType,
  type ItemAttributeSpec,
  type ItemTypeDoc,
  type ItemTypeDocument,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Pass 5d, Attribute validator.
 *
 * Order writes that arrive in the universal shape carry
 * `lineItems[i].itemTypeKey` + `attributes: Record<string, unknown>`. The
 * SHAPE of those attributes is per-tenant: defined in the org's `ItemType`
 * row's `attributeSchema[]`. The DB layer is intentionally loose
 * (`attributes: Mixed`) so a tenant can evolve their schema without a
 * collection-wide migration. Service-layer validation closes that hole:
 *
 *   1. The `itemTypeKey` must resolve to a real ItemType in the calling
 *      org. Cross-tenant key reuse is REFUSED, Tenant B cannot reference
 *      Tenant A's "rental_booking" definition (this is the same tenant-
 *      isolation discipline as Pass 5a's order/evidence lookups).
 *   2. Every `required: true` attribute on the spec must be present.
 *   3. Every supplied attribute must:
 *        - exist in the spec (no arbitrary keys, protects against
 *          attribute schema drift and prevents an attacker from
 *          smuggling extra payload through the API)
 *        - match the spec's `type` (STRING / NUMBER / DATE / URL / SELECT
 *          / BOOLEAN), with SELECT values constrained to the spec's
 *          `options[]`.
 *
 * Coerces inputs into canonical shapes (Date instances for DATE,
 * lowercased URLs validated against `URL()`, primitives narrowed). The
 * returned `attributes` object is what gets persisted onto the line
 * snapshot, callers should NOT use the raw input after validation.
 */

/** Public input shape. The validator coerces values into the right
 *  runtime types before persistence (e.g. ISO string → Date). */
export interface AttributeInput {
  [key: string]: unknown;
}

/** What we hand back to the caller, same keys, coerced values. */
export type ValidatedAttributes = Record<string, unknown>;

export interface ValidationResult {
  itemType: ItemTypeDoc;
  attributes: ValidatedAttributes;
}

/**
 * Resolve + validate a single line's `itemTypeKey` + `attributes` pair
 * within the calling org's scope. Throws `ValidationError` on failure.
 */
export async function validateLineAttributes(input: {
  orgId: string | null;
  itemTypeKey: string;
  attributes: AttributeInput;
  /** Optional context for nicer error messages, e.g. "line 2". */
  context?: string;
}): Promise<ValidationResult> {
  await connectMongo();
  const ctx = input.context ? `${input.context}: ` : "";

  if (!input.orgId) {
    throw new ValidationError(
      `${ctx}cannot validate item type "${input.itemTypeKey}" without an org context, universal orders require a tenant.`,
    );
  }

  const orgObjectId = new Types.ObjectId(input.orgId);
  const itemType = (await ItemType.findOne({
    orgId: orgObjectId,
    key: input.itemTypeKey,
  })) as ItemTypeDocument | null;

  if (!itemType) {
    // Refusing rather than auto-seeding, auto-seed across tenants would
    // be the cross-tenant leak Pass 5a closed for orders/evidence.
    throw new ValidationError(
      `${ctx}item type "${input.itemTypeKey}" is not defined for this organization. Create it via the admin catalog before referencing it on an order.`,
    );
  }

  const spec = itemType.attributeSchema ?? [];
  const specByKey = new Map<string, ItemAttributeSpec>(
    spec.map((s) => [s.key, s]),
  );
  const out: ValidatedAttributes = {};

  // Required-key sweep first so missing-required surfaces before
  // type errors on unrelated keys.
  for (const s of spec) {
    if (
      s.required &&
      (input.attributes[s.key] === undefined ||
        input.attributes[s.key] === null ||
        input.attributes[s.key] === "")
    ) {
      throw new ValidationError(
        `${ctx}attribute "${s.key}" is required on item type "${input.itemTypeKey}".`,
      );
    }
  }

  for (const [key, raw] of Object.entries(input.attributes)) {
    if (raw === undefined || raw === null) continue;
    const s = specByKey.get(key);
    if (!s) {
      throw new ValidationError(
        `${ctx}attribute "${key}" is not declared on item type "${input.itemTypeKey}". Declared attributes: ${spec.map((x) => x.key).join(", ") || "(none)"}.`,
      );
    }
    out[key] = coerceAttribute(s, raw, ctx);
  }

  return { itemType: itemType.toObject() as ItemTypeDoc, attributes: out };
}

function coerceAttribute(
  spec: ItemAttributeSpec,
  raw: unknown,
  ctx: string,
): unknown {
  switch (spec.type) {
    case ItemAttributeType.STRING: {
      if (typeof raw !== "string") {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be a string.`,
        );
      }
      return raw;
    }
    case ItemAttributeType.NUMBER: {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be a finite number.`,
        );
      }
      return n;
    }
    case ItemAttributeType.BOOLEAN: {
      if (typeof raw !== "boolean") {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be a boolean.`,
        );
      }
      return raw;
    }
    case ItemAttributeType.DATE: {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be a valid ISO date.`,
        );
      }
      return d;
    }
    case ItemAttributeType.URL: {
      if (typeof raw !== "string") {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be a URL string.`,
        );
      }
      try {
         
        new URL(raw);
      } catch {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" is not a valid URL.`,
        );
      }
      return raw;
    }
    case ItemAttributeType.SELECT: {
      if (typeof raw !== "string") {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be one of: ${(spec.options ?? []).join(", ")}`,
        );
      }
      if (!spec.options?.includes(raw)) {
        throw new ValidationError(
          `${ctx}attribute "${spec.key}" must be one of: ${(spec.options ?? []).join(", ")} (received "${raw}").`,
        );
      }
      return raw;
    }
    default: {
      // Exhaustive, unreachable at the type level.
      throw new ValidationError(
        `${ctx}attribute "${spec.key}" has an unsupported type "${String(spec.type)}".`,
      );
    }
  }
}
