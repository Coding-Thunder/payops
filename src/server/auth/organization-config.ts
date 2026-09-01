import "server-only";

import { Types } from "mongoose";

import { env } from "@/lib/env";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Per-organization configuration that reaches CUSTOMERS.
 *
 * These three things were deployment-wide, which is correct for one brand on
 * one deployment and wrong the moment a database serves two:
 *
 *   APP URL   builds the consent link, the acknowledgement link and the
 *             gateway return URLs. Shared, a cruise customer who pays is
 *             bounced to the car-rental brand's domain.
 *   LEGAL     frozen onto every order and shown in the receipt and the
 *             dispute evidence pack. Shared, a flight passenger is charged
 *             under car-rental terms about fuel levels and driver licences.
 *   EMAIL CC  copies every outgoing customer email. Shared, one brand's
 *             support inbox receives the other brand's customer mail —
 *             two separate legal entities, one PII leak.
 *
 * EVERY LOOKUP FALLS BACK TO THE DEPLOYMENT VALUE. An organization that
 * leaves a field empty behaves exactly as it does today, so the incumbent
 * brand is untouched until someone deliberately sets a per-brand value.
 *
 * Resolution is by ORDER-OWNING organization id where one is available, not
 * by the ambient request — a confirmation email sent from a webhook or the
 * outbox drainer must carry the brand that owns the order, whoever happens
 * to be logged in.
 */

interface OrganizationCustomerConfig {
  appUrl: string;
  cc: string | undefined;
  legal: {
    termsAndConditions: string;
    termsVersion: string;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
  } | null;
}

type Row = {
  appUrl?: string;
  email?: { cc?: string };
  legal?: {
    termsAndConditions?: string;
    termsVersion?: string;
    cancellationPolicy?: string;
    cancellationPolicyVersion?: string;
  };
};

/** Trailing slashes are stripped so callers can concatenate paths safely. */
function normaliseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

const DEPLOYMENT_FALLBACK: OrganizationCustomerConfig = {
  appUrl: "",
  cc: undefined,
  legal: null,
};

async function loadRow(organizationId: string | null): Promise<Row | null> {
  if (!organizationId || !Types.ObjectId.isValid(organizationId)) return null;
  await connectMongo();
  return Organization.findById(organizationId)
    .select("appUrl email.cc legal")
    .lean<Row | null>();
}

/**
 * The customer-facing base URL for an organization, falling back to the
 * deployment's `APP_URL`.
 */
export async function resolveAppUrl(
  organizationId: string | null,
): Promise<string> {
  const deployment = normaliseUrl(env.server.APP_URL);
  const row = await loadRow(organizationId).catch(() => null);
  const own = row?.appUrl?.trim();
  return own ? normaliseUrl(own) : deployment;
}

/**
 * The CC address for an organization's customer email, falling back to the
 * deployment-wide `EMAIL_CC`.
 *
 * Returns undefined when neither is set, which the transport reads as "send
 * the message untouched".
 */
export async function resolveEmailCc(
  organizationId: string | null,
): Promise<string | undefined> {
  const row = await loadRow(organizationId).catch(() => null);
  const own = row?.email?.cc?.trim();
  if (own) return own;
  const deployment = env.server.EMAIL_CC?.trim();
  return deployment || undefined;
}

/**
 * An organization's own legal text, or null to inherit the deployment
 * Settings singleton. Individual empty fields inherit individually, so a
 * brand can override only its cancellation policy if that is all it needs.
 */
export async function resolveOrganizationLegal(
  organizationId: string | null,
): Promise<OrganizationCustomerConfig["legal"]> {
  const row = await loadRow(organizationId).catch(() => null);
  const legal = row?.legal;
  if (!legal) return null;
  const any =
    legal.termsAndConditions?.trim() ||
    legal.termsVersion?.trim() ||
    legal.cancellationPolicy?.trim() ||
    legal.cancellationPolicyVersion?.trim();
  if (!any) return null;
  return {
    termsAndConditions: legal.termsAndConditions?.trim() ?? "",
    termsVersion: legal.termsVersion?.trim() ?? "",
    cancellationPolicy: legal.cancellationPolicy?.trim() ?? "",
    cancellationPolicyVersion: legal.cancellationPolicyVersion?.trim() ?? "",
  };
}

export { DEPLOYMENT_FALLBACK };
