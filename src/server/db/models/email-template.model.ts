import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  CUSTOM_TEMPLATE_KEY_REGEX,
  SYSTEM_EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKind,
  type SystemEmailTemplateKey,
} from "@/lib/constants/email-templates";

import { registerModel } from "./register";

export {
  SYSTEM_EMAIL_TEMPLATE_KEYS,
  CUSTOM_TEMPLATE_KEY_REGEX,
};
export type { SystemEmailTemplateKey, EmailTemplateKind };

/**
 * Versioned email-template content.
 *
 * The layout / structure stays code-controlled (see
 * `server/email/templates/`); this collection only holds the editable
 * COPY fields per template per version. That keeps the no-code editor
 * safe (admins can't inject arbitrary HTML or break the email frame)
 * while still letting Operations tweak greetings, intros, footers, and
 * notes without a redeploy.
 *
 * Versioning model:
 *   - one document per (templateKey, version), `version` is monotonic
 *     per key, starts at 1, increments on each new save.
 *   - exactly one row per key has `active = true` ("the live copy").
 *   - rows are immutable except for `active` and `updatedAt` (so an
 *     admin can flip activation between versions but can't retro-edit
 *     historical content). Edits = new version.
 */

export interface EmailTemplateContent {
  /** Custom subject line. Falls back to code default when null. */
  subject: string | null;
  /** Custom greeting (e.g. "Hi {customerName},"). */
  greeting: string | null;
  /** Custom intro paragraph. */
  intro: string | null;
  /** Optional custom note rendered above the support block. */
  note: string | null;
  /** Custom headline above the support buttons. */
  supportHeadline: string | null;
  /** Custom description text for the support block. */
  supportDescription: string | null;
  /** Custom extra line appended to the footer. */
  footerNote: string | null;
}

/**
 * Future automation hook. Empty array today (no auto-trigger engine
 * yet); when status-driven automations land, each binding fires the
 * template on a matching domain event. Schema lives on the template
 * itself so we never have to migrate to wire automations later.
 */
export interface EmailTemplateTriggerBinding {
  /** Domain event identifier, e.g. "order.status.PAID". */
  event: string;
  /** Per-binding kill-switch so an admin can pause a single auto-fire
   *  without deleting it. */
  enabled: boolean;
}

export interface EmailTemplateDoc extends EmailTemplateContent {
  /** Tenant boundary. Nullable during migration; per-org template
   *  overrides land once the column is fully backfilled. */
  orgId?: Types.ObjectId | null;
  /** System keys (payment-request, payment-confirmation) match
   *  SystemEmailTemplateKey. Custom kinds carry tenant-defined slugs
   *  matched against CUSTOM_TEMPLATE_KEY_REGEX. */
  templateKey: string;
  /** Discriminator between platform-defined ("system") templates and
   *  tenant-defined ("custom") ones. Drives admin UI behaviour
   *  (system templates can be edited but not renamed/deleted; custom
   *  templates are fully tenant-controlled). */
  kind: EmailTemplateKind;
  /** Operator-facing label. Required for custom templates ("Payment
   *  Reminder", "Refund Approved"); falls back to a code-defined
   *  label for system templates. */
  displayName: string;
  /** Optional operator-facing note shown in the admin list — what the
   *  template is for, when to send it. */
  description?: string | null;
  /** Future automation hook. Empty today, populated once the
   *  workflow engine grows status-driven dispatch. */
  triggerBindings: EmailTemplateTriggerBinding[];
  version: number;
  active: boolean;

  createdBy: {
    userId: Types.ObjectId;
    name: string;
  };

  createdAt: Date;
  updatedAt: Date;
}

export type EmailTemplateDocument = HydratedDocument<EmailTemplateDoc>;

const creatorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },
  },
  { _id: false },
);

const emailTemplateSchema = new Schema<EmailTemplateDoc>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },
    templateKey: {
      type: String,
      required: true,
      maxlength: 64,
      // Relaxed from the SYSTEM_EMAIL_TEMPLATE_KEYS enum so tenant
      // custom kinds can occupy the same collection. The service layer
      // enforces the right shape: system keys must come from the
      // constant; custom keys must match CUSTOM_TEMPLATE_KEY_REGEX
      // AND must not collide with any system key.
      index: true,
    },
    kind: {
      type: String,
      enum: ["system", "custom"] satisfies EmailTemplateKind[],
      required: true,
      default: "system",
      index: true,
    },
    displayName: { type: String, default: "", maxlength: 120, trim: true },
    description: { type: String, default: null, maxlength: 500, trim: true },
    triggerBindings: {
      type: [
        new Schema<EmailTemplateTriggerBinding>(
          {
            event: { type: String, required: true, maxlength: 120 },
            enabled: { type: Boolean, required: true, default: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    version: { type: Number, required: true, min: 1, index: true },
    active: { type: Boolean, required: true, default: false, index: true },

    subject: { type: String, default: null, maxlength: 200, trim: true },
    greeting: { type: String, default: null, maxlength: 200, trim: true },
    intro: { type: String, default: null, maxlength: 2000, trim: true },
    note: { type: String, default: null, maxlength: 2000, trim: true },
    supportHeadline: {
      type: String,
      default: null,
      maxlength: 200,
      trim: true,
    },
    supportDescription: {
      type: String,
      default: null,
      maxlength: 2000,
      trim: true,
    },
    footerNote: { type: String, default: null, maxlength: 500, trim: true },

    createdBy: { type: creatorSchema, required: true },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "email_templates",
  },
);

// Versions are unique per template-key.
emailTemplateSchema.index(
  { templateKey: 1, version: 1 },
  { unique: true, name: "email_templates_key_version" },
);
// Only one active row per key, enforced at the service layer (Mongo's
// partial-unique-index syntax is hairy with bool true filter under
// concurrent writes; serializing activation through a single service
// is cleaner).
emailTemplateSchema.index({ templateKey: 1, active: 1 });
// Per-tenant unique (templateKey, version). Partial filter keeps the
// legacy global unique authoritative during migration. Once every row
// carries orgId, drop the global unique and promote this one.
emailTemplateSchema.index(
  { orgId: 1, templateKey: 1, version: 1 },
  {
    unique: true,
    partialFilterExpression: { orgId: { $type: "objectId" } },
    name: "email_templates_orgId_key_version_unique",
  },
);

export const EmailTemplate: Model<EmailTemplateDoc> =
  registerModel<EmailTemplateDoc>("EmailTemplate", emailTemplateSchema);
