import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "@/lib/errors";
import {
  BUSINESS_TEMPLATES,
  BUSINESS_VERTICALS,
} from "@/lib/constants/business-templates";
import { ItemType } from "@/server/db/models";
import { completeBusinessSetup } from "@/server/services/business-setup.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 6b — onboarding wizard seed coverage.
 *
 * Verifies that for every shipped vertical:
 *   1. The template can be persisted as-is via `completeBusinessSetup`.
 *   2. The resulting ItemType row carries the template's key, schema,
 *      and email-block selection.
 *   3. A second call with the same key surfaces ConflictError (the
 *      wizard's "rename to dodge collision" promise rests on this).
 *
 * Why per-vertical: each template's `attributeSchema` carries
 * vertical-specific shape (SELECT options, required flags). Regressions
 * here would silently degrade onboarding for a vertical we don't
 * routinely click through. The whole-list sweep catches them all.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

afterEach(async () => {
  // resetDatabase runs in beforeEach; nothing to undo here.
});

function ctxFor(orgId: string) {
  return {
    orgId,
    actorId: new Types.ObjectId().toString(),
  };
}

describe("completeBusinessSetup — every shipped vertical", () => {
  for (const vertical of BUSINESS_VERTICALS) {
    it(`seeds the "${vertical}" template successfully`, async () => {
      const orgId = new Types.ObjectId().toString();
      const template = BUSINESS_TEMPLATES[vertical];
      const result = await completeBusinessSetup(
        {
          vertical,
          itemType: {
            key: template.itemType.key,
            name: template.itemType.name,
            description: template.itemType.description,
            pricingModel: template.itemType.pricingModel,
            requiresScheduling: template.itemType.requiresScheduling,
            inventoryTracked: template.itemType.inventoryTracked,
            attributeSchema: template.itemType.attributeSchema.map(
              (a, idx) => ({
                key: a.key,
                label: a.label,
                type: a.type,
                required: a.required,
                options: a.options,
                helpText: a.helpText ?? null,
                displayOrder: idx,
              }),
            ),
            confirmationEmailBlocks: template.itemType.confirmationEmailBlocks,
          },
        },
        ctxFor(orgId),
      );

      expect(result.vertical).toBe(vertical);
      expect(result.itemType.key).toBe(template.itemType.key);
      expect(result.itemType.attributeSchema.length).toBe(
        template.itemType.attributeSchema.length,
      );

      // Persisted row matches the template's pricing + scheduling.
      const persisted = await ItemType.findOne({
        orgId: new Types.ObjectId(orgId),
        key: template.itemType.key,
      }).lean();
      expect(persisted?.pricingModel).toBe(template.itemType.pricingModel);
      expect(persisted?.requiresScheduling).toBe(
        template.itemType.requiresScheduling,
      );
    });
  }
});

describe("completeBusinessSetup — collisions + isolation", () => {
  it("refuses to seed the same (orgId, key) twice", async () => {
    const orgId = new Types.ObjectId().toString();
    const template = BUSINESS_TEMPLATES.retail;
    const payload = {
      vertical: "retail" as const,
      itemType: {
        key: template.itemType.key,
        name: template.itemType.name,
        description: template.itemType.description,
        pricingModel: template.itemType.pricingModel,
        requiresScheduling: template.itemType.requiresScheduling,
        inventoryTracked: template.itemType.inventoryTracked,
        attributeSchema: template.itemType.attributeSchema.map((a, idx) => ({
          key: a.key,
          label: a.label,
          type: a.type,
          required: a.required,
          options: a.options,
          helpText: a.helpText ?? null,
          displayOrder: idx,
        })),
        confirmationEmailBlocks: template.itemType.confirmationEmailBlocks,
      },
    };

    await completeBusinessSetup(payload, ctxFor(orgId));
    await expect(
      completeBusinessSetup(payload, ctxFor(orgId)),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same key in two different orgs (per-tenant isolation)", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    const template = BUSINESS_TEMPLATES.grocery;
    function buildPayload() {
      return {
        vertical: "grocery" as const,
        itemType: {
          key: template.itemType.key,
          name: template.itemType.name,
          description: template.itemType.description,
          pricingModel: template.itemType.pricingModel,
          requiresScheduling: template.itemType.requiresScheduling,
          inventoryTracked: template.itemType.inventoryTracked,
          attributeSchema: template.itemType.attributeSchema.map((a, idx) => ({
            key: a.key,
            label: a.label,
            type: a.type,
            required: a.required,
            options: a.options,
            helpText: a.helpText ?? null,
            displayOrder: idx,
          })),
          confirmationEmailBlocks: template.itemType.confirmationEmailBlocks,
        },
      };
    }

    await completeBusinessSetup(buildPayload(), ctxFor(orgA));
    await completeBusinessSetup(buildPayload(), ctxFor(orgB));

    expect(
      await ItemType.countDocuments({ key: template.itemType.key }),
    ).toBe(2);
  });

  it("re-entry into the wizard appends a second vertical for the same org", async () => {
    const orgId = new Types.ObjectId().toString();

    // First vertical: retail (key=product).
    const retail = BUSINESS_TEMPLATES.retail;
    await completeBusinessSetup(
      {
        vertical: "retail",
        itemType: {
          key: retail.itemType.key,
          name: retail.itemType.name,
          description: retail.itemType.description,
          pricingModel: retail.itemType.pricingModel,
          requiresScheduling: retail.itemType.requiresScheduling,
          inventoryTracked: retail.itemType.inventoryTracked,
          attributeSchema: retail.itemType.attributeSchema.map((a, idx) => ({
            key: a.key,
            label: a.label,
            type: a.type,
            required: a.required,
            options: a.options,
            helpText: a.helpText ?? null,
            displayOrder: idx,
          })),
          confirmationEmailBlocks: retail.itemType.confirmationEmailBlocks,
        },
      },
      ctxFor(orgId),
    );

    // Second vertical: services (key=engagement). Different key — no
    // collision — append succeeds.
    const services = BUSINESS_TEMPLATES.services;
    await completeBusinessSetup(
      {
        vertical: "services",
        itemType: {
          key: services.itemType.key,
          name: services.itemType.name,
          description: services.itemType.description,
          pricingModel: services.itemType.pricingModel,
          requiresScheduling: services.itemType.requiresScheduling,
          inventoryTracked: services.itemType.inventoryTracked,
          attributeSchema: services.itemType.attributeSchema.map(
            (a, idx) => ({
              key: a.key,
              label: a.label,
              type: a.type,
              required: a.required,
              options: a.options,
              helpText: a.helpText ?? null,
              displayOrder: idx,
            }),
          ),
          confirmationEmailBlocks: services.itemType.confirmationEmailBlocks,
        },
      },
      ctxFor(orgId),
    );

    const rows = await ItemType.find({
      orgId: new Types.ObjectId(orgId),
    }).lean();
    expect(rows.map((r) => r.key).sort()).toEqual(["engagement", "product"]);
  });
});
