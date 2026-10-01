import "server-only";

import { ServiceType } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { serviceTypeOf, type ServiceSummarySource } from "@/lib/service-summary";

import type { EmailIdentity, PublicBrand } from "./identity";

/**
 * Customer-facing identity per SERVICE TYPE, within one organization.
 *
 * The existing resolvers in `./identity` answer "which ORGANIZATION's brand
 * is this?". That is the right axis for a deployment where each brand is a
 * separate tenant, which is how the `main` branch does it — FlightBizz and
 * GlobeVista are organizations there, not service types.
 *
 * This deployment is different: ONE organization sells two things under two
 * names. Car rentals go out as Rental Travels; flights go out as Airfare
 * Fees. So brand is a function of (organization, serviceType), and this
 * module supplies the second half.
 *
 * WHY AN OVERLAY RATHER THAN A SECOND RESOLVER. Every existing call site
 * already resolves the organization brand correctly, and car output must stay
 * byte-identical. An overlay that returns its input unchanged for CAR_RENTAL
 * makes that guarantee structural: there is no car code path through here
 * that can produce a different string, because the car path returns the very
 * same object it was handed.
 *
 * WHY ENV-CONFIGURED RATHER THAN HARD-CODED. "Airfare Fees" is this
 * deployment's flight brand, not a property of the software. The default is
 * the deployment's own value so nothing has to be set for it to work, and a
 * different flight brand is one variable away rather than a code change.
 * Nothing here is hard-coded into a shared component, which is the thing the
 * requirement actually forbids.
 */

/** Per-service-type overrides. A field left undefined keeps the
 *  organization's value — support contacts in particular are shared unless
 *  the flight brand genuinely has its own desk. */
export interface ServiceBrandOverride {
  brandName: string;
  supportEmail?: string;
  supportPhone?: string;
}

/**
 * The flight brand for this deployment.
 *
 * Support email/phone intentionally fall through to the organization's
 * unless explicitly configured: a brand name is a presentation choice, but
 * routing a customer to a support desk that does not exist is a real
 * failure. Set FLIGHT_SUPPORT_EMAIL / FLIGHT_SUPPORT_PHONE when the flight
 * business has its own.
 */
function flightOverride(): ServiceBrandOverride {
  return {
    brandName: env.server.FLIGHT_BRAND_NAME,
    supportEmail: env.server.FLIGHT_SUPPORT_EMAIL || undefined,
    supportPhone: env.server.FLIGHT_SUPPORT_PHONE || undefined,
  };
}

/** The override for a service type, or null when it uses the org brand. */
export function serviceBrandOverride(
  serviceType: ServiceType,
): ServiceBrandOverride | null {
  return serviceType === ServiceType.FLIGHT ? flightOverride() : null;
}

/**
 * Apply the service-type overlay to a resolved public brand.
 *
 * Returns the SAME OBJECT for a car order — not a copy — so a car surface
 * cannot drift from the organization brand even by accident.
 */
export function applyServiceBrand(
  brand: PublicBrand,
  order: ServiceSummarySource,
): PublicBrand {
  const override = serviceBrandOverride(serviceTypeOf(order));
  if (!override) return brand;
  return {
    ...brand,
    brandName: override.brandName,
    supportEmail: override.supportEmail ?? brand.supportEmail,
    supportPhone: override.supportPhone ?? brand.supportPhone,
  };
}

/**
 * The same overlay for the EMAIL identity.
 *
 * `from` is deliberately NOT rewritten. The envelope sender is bound to the
 * mailbox that is actually authenticated with the SMTP host, and this
 * deployment's SPF record ends in `-all` — inventing a From address for a
 * brand whose domain does not authorise this server would get the mail
 * rejected or spam-foldered. The brand the customer READS is `brandName`,
 * which is what the templates render; the envelope stays the deliverable one.
 * Set a real mailbox and its SMTP credentials before changing that.
 */
export function applyServiceEmailIdentity(
  identity: EmailIdentity,
  order: ServiceSummarySource,
): EmailIdentity {
  const override = serviceBrandOverride(serviceTypeOf(order));
  if (!override) return identity;
  return {
    ...identity,
    brandName: override.brandName,
    supportEmail: override.supportEmail ?? identity.supportEmail,
    supportPhone: override.supportPhone ?? identity.supportPhone,
  };
}
