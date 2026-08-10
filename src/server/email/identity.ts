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
  "brandName" | "isDefault" | "email" | "support"
>;

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
    .select("brandName isDefault email support")
    .lean<OrgEmailConfig | null>();
  if (!org) return fallback;

  const fromEmail = org.email?.fromEmail?.trim() ?? "";

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
  const host = org.email?.transport?.host?.trim() ?? "";
  let transport: EmailIdentity["transport"] = null;
  if (host) {
    const pass = await getSecret({
      organizationId,
      provider: CredentialProvider.SMTP,
      field: CredentialField.PASSWORD,
    });
    if (pass) {
      transport = {
        host,
        port: org.email?.transport?.port ?? 587,
        secure: Boolean(org.email?.transport?.secure),
        user: org.email?.transport?.user ?? "",
        pass,
      };
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
    from: formatFrom(org.email?.fromName?.trim() || org.brandName, fromEmail),
    replyTo: org.email?.replyTo?.trim() ?? "",
    brandName: org.brandName,
    supportEmail: org.support?.email?.trim() || branding.supportEmail,
    supportPhone: org.support?.phone?.trim() || branding.supportPhone,
    transport,
  };
}
