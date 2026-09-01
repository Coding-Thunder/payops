import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import {
  PAYMENT_GATEWAY_KEYS,
  PaymentGatewayKey,
  RECORD_STATES,
  RecordState,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";

/**
 * A tenant: one brand, one domain, one sender identity, one payment
 * provider. RentalConfirmation and TripReservations are two rows here.
 *
 * Why this collection exists rather than more columns on `settings` /
 * `branding`: both of those are deployment singletons keyed `"default"`,
 * which is precisely the assumption being removed. Rather than widen them
 * and leave a singleton in the middle of a multi-tenant system, the
 * per-brand half of their content moves here and the singletons keep
 * serving the values they always did until each organization is populated
 * and verified. Nothing reads this collection until the resolvers are
 * switched over, phase by phase.
 *
 * What is deliberately NOT here: credentials. `payments.publishableKey` is
 * a publishable key (safe by definition) and `email.transport.user` is a
 * username. Every actual secret — Stripe secret key, Stripe webhook
 * secret, PayPal client secret, SMTP password — lives encrypted in
 * `organization_credentials` and is never returned by a query against this
 * document. See `secret-box.ts` for why that separation is load-bearing.
 *
 * `status` mirrors the Provider catalog's lifecycle:
 *   - ACTIVE   : selectable, operational workflows may run against it
 *   - DISABLED : hidden from the switcher, existing data stays readable
 *   - ARCHIVED : soft-deleted; same as DISABLED but signals "won't return"
 *
 * Hard deletion is intentionally unsupported — orders, disputes, and
 * evidence rows reference an organization for the lifetime of the record.
 */

/** URL-safe identifier used in the org switcher and per-org webhook paths. */
export const ORGANIZATION_SLUG_REGEX = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export interface OrganizationEmailTransport {
  /** Empty host means "no organization-specific transport" — the resolver
   *  falls back to the deployment SMTP settings. */
  host: string;
  port: number;
  /** true => SMTPS (465), false => STARTTLS (587). */
  secure: boolean;
  user: string;
}

export interface OrganizationEmail {
  /** Display name on the From header, e.g. "Rental Confirmation". */
  fromName: string;
  /** Envelope sender, e.g. "no-reply@rentalconfirmation.com". */
  fromEmail: string;
  /** Empty string means "no Reply-To header". */
  replyTo: string;
  /**
   * Address copied on every outgoing customer email FOR THIS BRAND.
   *
   * Empty falls back to the deployment-wide `EMAIL_CC`, which is what the
   * incumbent brand runs on today. That fallback is only safe while one
   * organization exists: on a shared deployment a deployment-wide CC would
   * copy one tenant's support inbox on the OTHER tenant's customer mail — a
   * PII leak across two separate legal entities. Set this per brand.
   */
  cc: string;
  transport: OrganizationEmailTransport;
}

/**
 * Legal text frozen onto each of this organization's orders at creation.
 *
 * Empty strings mean "inherit the deployment Settings singleton", which is
 * what the incumbent brand does and will keep doing — its orders carry
 * exactly the terms they carry today. A brand selling cruises should not be
 * showing its customers car-rental terms in the receipt and the dispute
 * evidence chain, which is the only reason this block exists.
 */
export interface OrganizationLegal {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
}

export interface OrganizationBranding {
  /** Public path to the brand mark. Empty string hides it. */
  logo: string;
  primaryColor: string;
  onPrimaryColor: string;
  footerTagline: string;
}

export interface OrganizationSupport {
  email: string;
  phone: string;
}

export interface OrganizationPayments {
  /** Default gateway for a NEW payment link. */
  provider: PaymentGatewayKey;
  /**
   * Every gateway this organization may use. An operator can pick any of
   * these per order; anything outside the list is refused, so a stray value
   * from the client cannot select a provider the brand has no account for.
   *
   * Empty means "just `provider`", which is how existing rows read. A brand
   * can therefore start on one gateway and add a second later — e.g.
   * TripReservations on PayPal today, with its own Stripe account added
   * alongside — without a schema change, because credentials are already
   * namespaced per (organization, provider).
   */
  enabledProviders: PaymentGatewayKey[];
  /** Publishable / client id — safe to expose to the browser. The matching
   *  secret lives in `organization_credentials`. */
  publishableKey: string;
  /** Best-effort indicator that the configured credentials are test-mode.
   *  Surfaced in admin UIs so an operator never confuses live and sandbox. */
  sandbox: boolean;
}

export interface OrganizationDoc {
  slug: string;
  /** Internal / operations name. */
  name: string;
  /** Customer-facing brand name used in emails and on payment pages. */
  brandName: string;
  /** Primary domain, e.g. "tripreservations.co.uk". Empty until assigned. */
  domain: string;
  status: RecordState;
  /**
   * Exactly one organization carries this flag. It is the compatibility
   * anchor: any pre-existing record with no `organizationId` resolves here,
   * so nothing written before organizations existed can become
   * unreachable. Enforced by a partial unique index below.
   */
  isDefault: boolean;
  branding: OrganizationBranding;
  support: OrganizationSupport;
  email: OrganizationEmail;
  payments: OrganizationPayments;
  /**
   * Which service types this organization may create orders for.
   *
   * Defaults to `[CAR_RENTAL]`, which is what the incumbent deployment
   * sells — so its create-order page renders exactly as it does today, with
   * no tab strip. RCR Cruise is seeded `[FLIGHT, CRUISE]`.
   *
   * This is a TENANT-SCOPE list, not a UI hint: the create-order route
   * refuses a service type absent from it, so a hand-crafted POST cannot
   * write an order shape this brand does not sell.
   *
   * Read it as `serviceTypes?.length ? serviceTypes : [CAR_RENTAL]` — the
   * resolvers use `.lean()`, which does NOT apply Mongoose defaults to keys
   * absent from the stored document.
   */
  serviceTypes: ServiceType[];
  legal: OrganizationLegal;
  /**
   * Customer-facing base URL for THIS brand — the origin used to build the
   * consent link, the acknowledgement link and the gateway return URLs.
   *
   * Empty falls back to the deployment's `APP_URL`, which is correct for a
   * single-brand deployment. When two brands share one deployment it is
   * not: without this, a cruise customer who pays is redirected to the
   * car-rental brand's domain, and the consent link in their email points
   * at the wrong company.
   */
  appUrl: string;
  createdBy?: Types.ObjectId | null;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationDocument = HydratedDocument<OrganizationDoc>;

const brandingSubSchema = new Schema<OrganizationBranding>(
  {
    logo: { type: String, default: "", maxlength: 200 },
    primaryColor: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#0B1220",
    },
    onPrimaryColor: {
      type: String,
      required: true,
      match: /^#[0-9A-Fa-f]{6}$/,
      default: "#FFFFFF",
    },
    footerTagline: { type: String, default: "", maxlength: 200, trim: true },
  },
  { _id: false },
);

const supportSubSchema = new Schema<OrganizationSupport>(
  {
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    phone: { type: String, default: "", trim: true, maxlength: 32 },
  },
  { _id: false },
);

const emailTransportSubSchema = new Schema<OrganizationEmailTransport>(
  {
    host: { type: String, default: "", trim: true, maxlength: 253 },
    port: { type: Number, default: 587, min: 1, max: 65535 },
    secure: { type: Boolean, default: false },
    user: { type: String, default: "", trim: true, maxlength: 254 },
  },
  { _id: false },
);

const emailSubSchema = new Schema<OrganizationEmail>(
  {
    fromName: { type: String, default: "", trim: true, maxlength: 120 },
    fromEmail: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    replyTo: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    cc: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    transport: {
      type: emailTransportSubSchema,
      required: true,
      default: () => ({}),
    },
  },
  { _id: false },
);

const paymentsSubSchema = new Schema<OrganizationPayments>(
  {
    provider: {
      type: String,
      enum: PAYMENT_GATEWAY_KEYS,
      required: true,
      default: PaymentGatewayKey.STRIPE,
    },
    enabledProviders: {
      type: [String],
      enum: PAYMENT_GATEWAY_KEYS,
      required: true,
      // Thunk: a shared array literal would be mutated across documents.
      default: () => [],
    },
    publishableKey: { type: String, default: "", trim: true, maxlength: 255 },
    sandbox: { type: Boolean, default: false },
  },
  { _id: false },
);

const legalSubSchema = new Schema<OrganizationLegal>(
  {
    termsAndConditions: { type: String, default: "", maxlength: 8000 },
    termsVersion: { type: String, default: "", maxlength: 16, trim: true },
    cancellationPolicy: { type: String, default: "", maxlength: 4000 },
    cancellationPolicyVersion: {
      type: String,
      default: "",
      maxlength: 16,
      trim: true,
    },
  },
  { _id: false },
);

const organizationSchema = new Schema<OrganizationDoc>(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 40,
      match: ORGANIZATION_SLUG_REGEX,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    brandName: { type: String, required: true, trim: true, maxlength: 80 },
    domain: { type: String, default: "", lowercase: true, trim: true, maxlength: 253 },
    status: {
      type: String,
      enum: RECORD_STATES,
      required: true,
      default: RecordState.ACTIVE,
      index: true,
    },
    isDefault: { type: Boolean, required: true, default: false },
    branding: {
      type: brandingSubSchema,
      required: true,
      default: () => ({}),
    },
    support: { type: supportSubSchema, required: true, default: () => ({}) },
    email: { type: emailSubSchema, required: true, default: () => ({}) },
    payments: { type: paymentsSubSchema, required: true, default: () => ({}) },
    serviceTypes: {
      type: [String],
      enum: SERVICE_TYPES,
      required: true,
      // Thunk: a shared array literal would be mutated across documents.
      default: () => [ServiceType.CAR_RENTAL],
    },
    legal: { type: legalSubSchema, required: true, default: () => ({}) },
    appUrl: { type: String, default: "", trim: true, maxlength: 253 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "organizations",
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>;
        r.id = String(r._id);
        delete r._id;
        return r;
      },
    },
  },
);

// `slug` already carries `unique: true` inline, so no separate index call —
// declaring both emits a duplicate-index warning at startup.

// At most one default organization. A partial index constrains only the
// documents where the flag is true, so every non-default row is free to
// share `isDefault: false` without colliding.
organizationSchema.index(
  { isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

organizationSchema.index({ status: 1, name: 1 });

import { registerModel } from "./register";
export const Organization: Model<OrganizationDoc> =
  registerModel<OrganizationDoc>("Organization", organizationSchema);
