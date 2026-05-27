import "server-only";

import { ConflictError } from "@/lib/errors";
import {
  createItemType,
  type ItemTypeAttributeDTO,
  type ItemTypeContext,
  type ItemTypeDTO,
} from "./item-type.service";
import type { CompleteBusinessSetupInput } from "@/lib/validation";

/**
 * Pass 6b — onboarding wizard commit.
 *
 * The wizard's last step posts a `CompleteBusinessSetupInput` here.
 * We translate it into a `createItemType` call on the existing
 * service. Two reasons to go through this thin layer rather than
 * letting the route call `createItemType` directly:
 *
 *   1. Single place to log + audit the "tenant finished onboarding"
 *      event in future passes (gateway-side analytics, "first ItemType
 *      created" milestone tracking).
 *   2. Translation point if/when the wizard ever needs to seed more
 *      than one row (catalog Items, default settings tweaks, etc.).
 *      Today it seeds exactly one ItemType.
 *
 * Re-entry behaviour: the user explicitly chose "Allow — append" in
 * Pass 6b verification, so this function does NOT refuse if other
 * ItemTypes already exist for the org. It DOES surface a clear
 * `ConflictError` when the chosen key collides with an existing row;
 * the wizard's step 3 already lets the user rename to dodge that.
 */
export interface BusinessSetupResult {
  itemType: ItemTypeDTO;
  vertical: CompleteBusinessSetupInput["vertical"];
}

export async function completeBusinessSetup(
  input: CompleteBusinessSetupInput,
  ctx: ItemTypeContext,
): Promise<BusinessSetupResult> {
  try {
    const itemType = await createItemType(
      {
        key: input.itemType.key,
        name: input.itemType.name,
        description: input.itemType.description ?? null,
        pricingModel: input.itemType.pricingModel,
        requiresScheduling: input.itemType.requiresScheduling,
        inventoryTracked: input.itemType.inventoryTracked,
        attributeSchema: input.itemType.attributeSchema.map(
          (a): ItemTypeAttributeDTO => ({
            key: a.key,
            label: a.label,
            type: a.type,
            required: a.required,
            options: a.options,
            helpText: a.helpText ?? null,
            displayOrder: a.displayOrder,
          }),
        ),
        confirmationEmailBlocks: input.itemType.confirmationEmailBlocks ?? [],
      },
      ctx,
    );
    return { itemType, vertical: input.vertical };
  } catch (err) {
    // Surface the duplicate-key case with the exact key so the wizard
    // can render a focused "rename this" message instead of a generic
    // 500. ConflictError already carries an HTTP 409 mapping in
    // `lib/errors.ts`; we re-throw verbatim.
    if (err instanceof ConflictError) throw err;
    throw err;
  }
}
