import {
  EmailBlockKey,
  ItemAttributeType,
  ItemPricingModel,
  SchedulingType,
} from "./items";

/**
 * Pass 6b — Business-vertical starter templates.
 *
 * Platform-controlled finite list. A non-technical founder picks one
 * during the onboarding wizard and we seed a single ItemType named
 * after the vertical's main transaction. They customize fields inline
 * before saving; the rest is handed off to the admin Item types page
 * post-onboarding.
 *
 * Why a finite hardcoded list (vs. DB rows or a builder UI):
 *   1. New verticals deserve product review — adding "loan_servicing"
 *      or "subscription_box" forces us to think about whether the
 *      universal commerce primitives are still enough. A code change
 *      catches that; a DB-row mutation hides it.
 *   2. Each template has an attribute schema that has to FEEL right
 *      for the vertical. Curated > generated.
 *   3. Tenants do not need to mint new verticals — they need a fast
 *      path from "empty workspace" to "first paid order". This list
 *      is for that path.
 *
 * Adding a new vertical:
 *   - Append a `BusinessTemplate` below.
 *   - Add the slug to `BUSINESS_VERTICALS`.
 *   - The wizard picker auto-discovers it via the export.
 */

export const BusinessVertical = {
  GROCERY: "grocery",
  RETAIL: "retail",
  REPAIR: "repair",
  DEALERSHIP: "dealership",
  EQUIPMENT: "equipment",
  SERVICES: "services",
  PHARMACY: "pharmacy",
  RENTAL: "rental",
  GENERIC: "generic",
} as const;
export type BusinessVertical =
  (typeof BusinessVertical)[keyof typeof BusinessVertical];
export const BUSINESS_VERTICALS = Object.values(
  BusinessVertical,
) as BusinessVertical[];

/** Single attribute spec inside a template's attributeSchema. Mirrors
 *  `ItemAttributeSpec` but the wizard builds these in code so the
 *  shape is platform-controlled at the template-definition site. */
export interface TemplateAttribute {
  key: string;
  label: string;
  type: ItemAttributeType;
  required: boolean;
  options?: string[];
  helpText?: string;
}

export interface BusinessTemplate {
  vertical: BusinessVertical;
  /** Wizard step 1 — card title. */
  displayName: string;
  /** Wizard step 1 — one-line elevator pitch. */
  tagline: string;
  /** Wizard step 1 — illustrative examples ("Phone repair, AC repair, …"). */
  examples: string[];
  /** Single ItemType seeded for this vertical. */
  itemType: {
    /** Stable key — persisted on every order line. snake_case. */
    key: string;
    name: string;
    description: string;
    pricingModel: ItemPricingModel;
    requiresScheduling: boolean;
    inventoryTracked: boolean;
    attributeSchema: TemplateAttribute[];
    confirmationEmailBlocks: EmailBlockKey[];
  };
}

/* ─────────────────────────── Templates ────────────────────────────────── */

export const BUSINESS_TEMPLATES: Record<BusinessVertical, BusinessTemplate> = {
  [BusinessVertical.GROCERY]: {
    vertical: BusinessVertical.GROCERY,
    displayName: "Grocery / general store",
    tagline: "Sell packaged goods, produce, or daily essentials.",
    examples: ["Kirana store", "milk shop", "convenience store", "organic market"],
    itemType: {
      key: "product",
      name: "Product",
      description: "Anything sold off the shelf — packaged or fresh.",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "unit_size",
          label: "Unit size",
          type: ItemAttributeType.SELECT,
          required: false,
          options: ["250g", "500g", "1kg", "2kg", "5kg", "1L", "2L", "5L"],
        },
        {
          key: "category",
          label: "Category",
          type: ItemAttributeType.STRING,
          required: false,
        },
      ],
      confirmationEmailBlocks: [EmailBlockKey.LINE_ITEMS_TABLE],
    },
  },

  [BusinessVertical.RETAIL]: {
    vertical: BusinessVertical.RETAIL,
    displayName: "Retail / e-commerce",
    tagline: "Sell physical goods — fashion, electronics, gifts.",
    examples: ["Clothing boutique", "gadget store", "gift shop"],
    itemType: {
      key: "product",
      name: "Product",
      description: "A physical item your customer takes home.",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "sku",
          label: "SKU",
          type: ItemAttributeType.STRING,
          required: false,
          helpText: "Your internal stock-keeping unit code.",
        },
        {
          key: "size",
          label: "Size",
          type: ItemAttributeType.SELECT,
          required: false,
          options: ["XS", "S", "M", "L", "XL", "XXL"],
        },
        {
          key: "color",
          label: "Color",
          type: ItemAttributeType.STRING,
          required: false,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.TRACKING_INFO,
      ],
    },
  },

  [BusinessVertical.REPAIR]: {
    vertical: BusinessVertical.REPAIR,
    displayName: "Repair / service shop",
    tagline: "Fix customer-owned equipment for a fee.",
    examples: [
      "Phone repair",
      "AC repair",
      "watch repair",
      "laptop service",
      "two-wheeler workshop",
    ],
    itemType: {
      key: "service_job",
      name: "Service job",
      description:
        "A repair or service task. Tracks the device, issue, and outcome.",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "device_make",
          label: "Device make",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "device_model",
          label: "Device model",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "serial_or_imei",
          label: "Serial / IMEI",
          type: ItemAttributeType.STRING,
          required: false,
          helpText:
            "Helps us tie the order to a specific device for warranty.",
        },
        {
          key: "issue",
          label: "Reported issue",
          type: ItemAttributeType.STRING,
          required: true,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.SCHEDULING_WINDOW,
      ],
    },
  },

  [BusinessVertical.DEALERSHIP]: {
    vertical: BusinessVertical.DEALERSHIP,
    displayName: "Dealership",
    tagline: "Sell or service vehicles — new, used, or fleet.",
    examples: [
      "Car dealership",
      "two-wheeler showroom",
      "used-vehicle resale",
    ],
    itemType: {
      key: "vehicle_sale",
      name: "Vehicle sale",
      description: "A specific vehicle being sold (or pre-booked).",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: false,
      inventoryTracked: true,
      attributeSchema: [
        {
          key: "vin",
          label: "VIN / chassis number",
          type: ItemAttributeType.STRING,
          required: false,
        },
        {
          key: "make",
          label: "Make",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "model",
          label: "Model",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "year",
          label: "Year",
          type: ItemAttributeType.NUMBER,
          required: false,
        },
        {
          key: "kms_driven",
          label: "Kilometres driven",
          type: ItemAttributeType.NUMBER,
          required: false,
          helpText: "Only relevant for used-vehicle sales.",
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.ITEM_HERO,
      ],
    },
  },

  [BusinessVertical.EQUIPMENT]: {
    vertical: BusinessVertical.EQUIPMENT,
    displayName: "Equipment rental",
    tagline: "Rent out industrial or commercial equipment by the day.",
    examples: ["JCB excavator hire", "generator rental", "event AV rental"],
    itemType: {
      key: "equipment_rental",
      name: "Equipment rental",
      description: "A rentable asset on a time-windowed basis.",
      pricingModel: ItemPricingModel.TIME_WINDOW,
      requiresScheduling: true,
      inventoryTracked: true,
      attributeSchema: [
        {
          key: "asset_tag",
          label: "Asset tag",
          type: ItemAttributeType.STRING,
          required: true,
          helpText: "Your internal id for this specific unit.",
        },
        {
          key: "asset_type",
          label: "Equipment type",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "daily_rate",
          label: "Daily rate",
          type: ItemAttributeType.NUMBER,
          required: false,
          helpText: "Reference rate — actual line price is per-order.",
        },
        {
          key: "deposit_amount",
          label: "Security deposit",
          type: ItemAttributeType.NUMBER,
          required: false,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.SCHEDULING_WINDOW,
        EmailBlockKey.ITEM_HERO,
      ],
    },
  },

  [BusinessVertical.SERVICES]: {
    vertical: BusinessVertical.SERVICES,
    displayName: "Services / consulting",
    tagline: "Sell engagements, retainers, or project work.",
    examples: ["Consulting", "marketing agency", "photography", "design studio"],
    itemType: {
      key: "engagement",
      name: "Engagement",
      description: "A scoped piece of work delivered over time.",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "deliverables",
          label: "Deliverables",
          type: ItemAttributeType.STRING,
          required: true,
          helpText: "What the customer gets at the end. Short list.",
        },
        {
          key: "revisions_included",
          label: "Revisions included",
          type: ItemAttributeType.NUMBER,
          required: false,
        },
        {
          key: "kickoff_call",
          label: "Kickoff call included",
          type: ItemAttributeType.BOOLEAN,
          required: false,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.SCHEDULING_WINDOW,
        EmailBlockKey.SIGNATURE_BLOCK,
      ],
    },
  },

  [BusinessVertical.PHARMACY]: {
    vertical: BusinessVertical.PHARMACY,
    displayName: "Pharmacy",
    tagline: "Fill prescriptions with refill + dispense records.",
    examples: ["Neighbourhood pharmacy", "online medicine"],
    itemType: {
      key: "prescription_fill",
      name: "Prescription fill",
      description:
        "A single dispense of medication tied to a prescription record.",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "rx_number",
          label: "Rx number",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "drug_name",
          label: "Medication",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "dosage",
          label: "Dosage",
          type: ItemAttributeType.STRING,
          required: false,
          helpText: "e.g. 500mg twice daily.",
        },
        {
          key: "refills_remaining",
          label: "Refills remaining",
          type: ItemAttributeType.NUMBER,
          required: false,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.PRESCRIPTION_BLOCK,
      ],
    },
  },

  [BusinessVertical.RENTAL]: {
    vertical: BusinessVertical.RENTAL,
    displayName: "Rental booking",
    tagline: "Rent vehicles, spaces, or experiences by time window.",
    examples: ["Car rental", "vacation home", "studio booking", "boat hire"],
    itemType: {
      key: "rental_booking",
      name: "Rental booking",
      description:
        "Time-windowed rental of an asset with provider + scheduling.",
      pricingModel: ItemPricingModel.TIME_WINDOW,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [
        {
          key: "asset_make",
          label: "Make / brand",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "asset_type",
          label: "Model / type",
          type: ItemAttributeType.STRING,
          required: true,
        },
        {
          key: "asset_image_url",
          label: "Image URL",
          type: ItemAttributeType.URL,
          required: false,
          helpText: "Public image shown on the order page + confirmation email.",
        },
        {
          key: "pickup_location",
          label: "Pickup location",
          type: ItemAttributeType.STRING,
          required: false,
        },
      ],
      confirmationEmailBlocks: [
        EmailBlockKey.LINE_ITEMS_TABLE,
        EmailBlockKey.SCHEDULING_WINDOW,
        EmailBlockKey.ITEM_HERO,
      ],
    },
  },

  [BusinessVertical.GENERIC]: {
    vertical: BusinessVertical.GENERIC,
    displayName: "Something else",
    tagline: "Start with a blank item and add fields as you need them.",
    examples: ["Use this if none of the above fit your business."],
    itemType: {
      key: "item",
      name: "Item",
      description: "Anything you sell — fields are entirely up to you.",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [EmailBlockKey.LINE_ITEMS_TABLE],
    },
  },
};

export const BUSINESS_TEMPLATE_LIST: BusinessTemplate[] =
  BUSINESS_VERTICALS.map((v) => BUSINESS_TEMPLATES[v]);

/** Pass `SchedulingType.FIXED_WINDOW` here for any vertical whose
 *  template sets `requiresScheduling: true`. Centralised so the seed
 *  service doesn't sprinkle the literal across the codebase. */
export const DEFAULT_SCHEDULING_TYPE: SchedulingType = SchedulingType.FIXED_WINDOW;
