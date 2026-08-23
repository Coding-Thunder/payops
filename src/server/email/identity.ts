import "server-only";

import { Types } from "mongoose";

import { env } from "@/lib/env";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  CredentialField,
  CredentialProvider,
  Order,
  Organization,
  type OrganizationDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getSecret } from "@/server/services/organization-credential.service";

/**
 * Who an email is FROM, and which mailbox actually sends it.
 *
 * Resolved from the ORDER'S organization, never from ambient request
 * context. Almost every customer email is dispatched by the outbox drainer
 * or a webhook, neither of which has a request, a session, or an
 * organization cookie — reading ambient scope there would silently give
 * every automated send the deployment default. Same reasoning as the
 * evidence and consent writes in P4.
 *
 * FALLBACK RULE, mirroring the payment gateway:
 *
 *   the DEFAULT organization falls back to the deployment's EMAIL_FROM /
 *   SMTP_* configuration. That is what keeps RentalConfirmation's mail
 *   byte-identical — same From, same Reply-To, same transport — until
 *   someone deliberately fills in its organization record.
 *
 *   any OTHER organization must have a sender configured. Falling back
 *   would post a TripReservations customer an email that says
 *   RentalConfirmation, from a rentalconfirmation.com address, about money
 *   they just paid. That is a trust and deliverability problem (SPF/DKIM
 *   will not align with the brand the customer expects) and it is worse
 *   than a visible failure an operator can fix.
 */

export interface EmailIdentity {
  /** RFC-5322 From header, e.g. `Rental Confirmation <no-reply@x.com>`. */
  from: string;
  /** Empty string means "no Reply-To header" — matches today's behaviour
   *  when EMAIL_REPLY_TO is unset. */
  replyTo: string;
  /** Customer-facing brand rendered into the body. */
  brandName: string;
  supportEmail: string;
  supportPhone: string;
  /** Null means "use the deployment SMTP transport". */
  transport: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  } | null;
}

/**
 * Per-organization SMTP secrets from the ENVIRONMENT, checked ahead of the
 * vault — same rule as payment credentials in resolve-gateway.ts.
 *
 * Slug uppercased with non-alphanumerics as underscores, so
 * `tripreservations` reads `ORG_TRIPRESERVATIONS_*`. Recognised suffixes:
 *
 *   EMAIL_FROM        sender address        (overrides email.fromEmail)
 *   EMAIL_FROM_NAME   display name          (overrides email.fromName)
 *   EMAIL_REPLY_TO    reply-to address      (overrides email.replyTo)
 *   SMTP_HOST/PORT/SECURE/USER              (override email.transport.*)
 *   SMTP_PASSWORD     the secret            (no document equivalent)
 *
 * Only SMTP_PASSWORD has to live here — it is the one value that must never
 * be in the database. The rest are ordinary configuration and are usually
 * better on the organization document, where they are visible and editable;
 * env support exists so a value set there is honoured rather than silently
 * ignored.
 */
function envKey(slug: string, suffix: string): string {
  return `ORG_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
}

function fromEnv(slug: string, suffix: string): string | null {
  const v = process.env[envKey(slug, suffix)];
  return v && v.trim() ? v.trim() : null;
}

/** Compose a From header the way nodemailer expects. */
function formatFrom(name: string, address: string): string {
  if (!name) return address;
  // Quote the display name if it contains anything RFC 5322 treats as a
  // special, so `Acme, Inc. <x@y.z>` does not parse as two addresses.
  const needsQuoting = /[",;:<>@[\]\\]/.test(name);
  const display = needsQuoting ? `"${name.replace(/"/g, '\\"')}"` : name;
  return `${display} <${address}>`;
}

type OrgEmailConfig = Pick<
  OrganizationDoc,
  "slug" | "brandName" | "isDefault" | "email" | "support"
>;

/**
 * The brand a CUSTOMER sees, for surfaces that are not email.
 *
 * `resolveEmailIdentity` above answers "who is this email from". This answers
 * the neighbouring question — "whose name, logo and support contacts go on
 * this page / this gateway checkout screen" — and it exists because those
 * surfaces were all reading the deployment Branding singleton directly, which
 * is RentalConfirmation's. A TripReservations customer was being emailed
 * correctly and then landing on a page (and a PayPal approval screen) badged
 * with the other brand.
 *
 * Same fallback rule as the email identity, for the same reason: the DEFAULT
 * organization resolves to the deployment singleton byte-for-byte, so nothing
 * about RentalConfirmation's output changes.
 */
export interface PublicBrand {
  /** Null for the deployment fallback (no organization, or the default one
   *  resolving to the singleton). Used to look up `ORG_<SLUG>_*` overrides. */
  slug: string | null;
  brandName: string;
  /** May be empty for a non-default organization that has configured none —
   *  callers must render the support block conditionally rather than
   *  substituting the deployment's address. */
  supportEmail: string;
  /** Empty means "this brand publishes no phone number". */
  supportPhone: string;
  logo: string;
  primaryColor: string;
  footerTagline: string;
  isDefault: boolean;
}

export interface PublicBrandFallback {
  brandName: string;
  supportEmail: string;
  supportPhone: string;
  logo?: string;
  primaryColor?: string;
  footerTagline?: string;
}

type OrgBrandConfig = Pick<
  OrganizationDoc,
  "slug" | "brandName" | "isDefault" | "email" | "support" | "branding"
>;

function fallbackBrand(
  fallback: PublicBrandFallback,
  slug: string | null = null,
): PublicBrand {
  return {
    slug,
    brandName: fallback.brandName,
    supportEmail: fallback.supportEmail,
    supportPhone: fallback.supportPhone,
    logo: fallback.logo ?? "",
    primaryColor: fallback.primaryColor ?? "#0B1220",
    footerTagline: fallback.footerTagline ?? "",
    isDefault: true,
  };
}

export async function resolvePublicBrand(
  organizationId: string | null,
  fallback: PublicBrandFallback,
): Promise<PublicBrand> {
  if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
    return fallbackBrand(fallback);
  }

  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select("slug brandName isDefault email support branding")
    .lean<OrgBrandConfig | null>();
  if (!org) return fallbackBrand(fallback);
  if (org.isDefault) return fallbackBrand(fallback, org.slug);

  // Support contacts deliberately do NOT fall back to the deployment's. An
  // unset value here means the brand publishes none; printing the incumbent's
  // support address and US phone number on another brand's booking is the
  // exact leak this function exists to close.
  //
  // The sending mailbox is a sound last resort for email only — it is this
  // brand's own address, and it is where a customer hitting Reply would land
  // anyway.
  const supportEmail =
    org.support?.email?.trim() ||
    fromEnv(org.slug, "EMAIL_FROM") ||
    org.email?.fromEmail?.trim() ||
    "";

  // Visual tokens are cosmetic, carry no other brand's identity, and an
  // organization that has uploaded no logo should still get a usable page.
  return {
    slug: org.slug,
    brandName: org.brandName,
    supportEmail,
    supportPhone: org.support?.phone?.trim() || "",
    logo: org.branding?.logo?.trim() || "",
    primaryColor:
      org.branding?.primaryColor?.trim() || fallback.primaryColor || "#0B1220",
    footerTagline: org.branding?.footerTagline?.trim() || "",
    isDefault: false,
  };
}

/** Convenience for the many callers that hold an order id, not an org id. */
export async function resolvePublicBrandForOrder(
  orderId: string,
  fallback: PublicBrandFallback,
): Promise<PublicBrand> {
  return resolvePublicBrand(await organizationIdForOrder(orderId), fallback);
}

/**
 * Brand for the `?order=<orderNumber>` the gateways append to their return
 * URLs. That param is all the /pay pages get, and it is enough — the only
 * thing derived from it here is which brand's name to print, which the
 * customer already knows. No booking detail is exposed by this lookup.
 */
export async function resolvePublicBrandForOrderNumber(
  orderNumber: string | null | undefined,
  fallback: PublicBrandFallback,
): Promise<PublicBrand> {
  const trimmed = orderNumber?.trim();
  if (!trimmed) return fallbackBrand(fallback);
  await connectMongo();
  const row = await Order.findOne({ orderNumber: trimmed })
    .select("organizationId")
    .lean<{ organizationId?: Types.ObjectId | null } | null>();
  return resolvePublicBrand(
    row?.organizationId ? String(row.organizationId) : null,
    fallback,
  );
}

/** The organization that owns an order, or null for pre-migration rows. */
export async function organizationIdForOrder(
  orderId: string,
): Promise<string | null> {
  if (!Types.ObjectId.isValid(orderId)) return null;
  await connectMongo();
  const row = await Order.findById(orderId)
    .select("organizationId")
    .lean<{ organizationId?: Types.ObjectId | null } | null>();
  return row?.organizationId ? String(row.organizationId) : null;
}

/**
 * Deployment-level identity: exactly what the service used before this
 * existed. `brandName` / support details still come from the caller, which
 * reads them off the Branding singleton, so this function does not change
 * where those are sourced.
 */
export function deploymentIdentity(branding: {
  brandName: string;
  supportEmail: string;
  supportPhone: string;
}): EmailIdentity {
  return {
    from: env.server.EMAIL_FROM,
    replyTo: env.server.EMAIL_REPLY_TO ?? "",
    brandName: branding.brandName,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    transport: null,
  };
}

/**
 * Identity for an organization, falling back per the rule above.
 *
 * `branding` is the deployment Branding singleton, used for the default
 * organization and for any field an organization leaves blank.
 */
export async function resolveEmailIdentity(
  organizationId: string | null,
  branding: { brandName: string; supportEmail: string; supportPhone: string },
): Promise<EmailIdentity> {
  const fallback = deploymentIdentity(branding);
  if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
    return fallback;
  }

  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select("slug brandName isDefault email support")
    .lean<OrgEmailConfig | null>();
  if (!org) return fallback;

  // Env first, organization document second — same precedence as payment
  // credentials. Without this, setting ORG_<SLUG>_EMAIL_FROM would be
  // silently ignored, which is worse than not supporting it at all.
  const fromEmail =
    fromEnv(org.slug, "EMAIL_FROM") ?? org.email?.fromEmail?.trim() ?? "";

  if (!fromEmail) {
    if (org.isDefault) {
      // Expected during the migration: the incumbent brand still sends from
      // EMAIL_FROM and nothing about its mail changes.
      return fallback;
    }
    logger.error("email.identity.not_configured", {
      organizationId,
      brandName: org.brandName,
    });
    throw new ConflictError(
      `${org.brandName} has no sender email configured. Set it in organization settings before sending customer email.`,
    );
  }

  // SMTP password lives in the vault; the rest of the transport is ordinary
  // configuration on the organization document.
  const host =
    fromEnv(org.slug, "SMTP_HOST") ?? org.email?.transport?.host?.trim() ?? "";
  let transport: EmailIdentity["transport"] = null;
  if (host) {
    // Env first, vault second.
    const pass =
      fromEnv(org.slug, "SMTP_PASSWORD") ??
      (await getSecret({
        organizationId,
        provider: CredentialProvider.SMTP,
        field: CredentialField.PASSWORD,
      }));
    if (pass) {
      transport = {
        host,
        port: Number(fromEnv(org.slug, "SMTP_PORT")) || org.email?.transport?.port || 587,
        secure:
          fromEnv(org.slug, "SMTP_SECURE") === "true" ||
          Boolean(org.email?.transport?.secure),
        user:
          fromEnv(org.slug, "SMTP_USER") ??
          org.email?.transport?.user ??
          "",
        pass,
      };
    } else if (org.isDefault) {
      // The DEFAULT organization falls back to the deployment transport,
      // exactly as it does for the From address above.
      //
      // The refusal below exists so a second brand's mail can never leave the
      // incumbent's mailbox. That reasoning does not apply here: for the
      // default organization the deployment mailbox IS its own mailbox. And
      // this state is the normal one, not an edge case — the seed copies the
      // deployment SMTP host onto the default organization's document, while
      // the password stays where it has always been, in SMTP_PASS. Throwing
      // here took the incumbent brand's email composer down with a message
      // telling the operator to fix configuration that was never wrong.
      logger.debug("email.transport.default_org_uses_deployment", {
        organizationId,
        host,
      });
    } else {
      // A host with no password cannot authenticate. Falling back to the
      // deployment transport would send this brand's mail out of the
      // incumbent's mailbox, so refuse rather than mis-send.
      logger.error("email.transport.incomplete", {
        organizationId,
        brandName: org.brandName,
        host,
      });
      throw new ConflictError(
        `${org.brandName} has an SMTP host configured but no password stored. Add it in organization settings.`,
      );
    }
  }

  return {
    from: formatFrom(
      fromEnv(org.slug, "EMAIL_FROM_NAME") ??
        org.email?.fromName?.trim() ??
        org.brandName,
      fromEmail,
    ),
    replyTo:
      fromEnv(org.slug, "EMAIL_REPLY_TO") ?? org.email?.replyTo?.trim() ?? "",
    brandName: org.brandName,
    // Only the DEFAULT organization inherits the deployment's support
    // contacts. For anyone else that fallback printed RentalConfirmation's
    // address and US phone number in another brand's booking email — the
    // sending mailbox is the correct last resort, and no phone at all is
    // better than someone else's.
    supportEmail:
      org.support?.email?.trim() ||
      (org.isDefault ? branding.supportEmail : fromEmail),
    supportPhone:
      org.support?.phone?.trim() || (org.isDefault ? branding.supportPhone : ""),
    transport,
  };
}
