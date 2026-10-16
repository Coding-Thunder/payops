import "server-only";

import { Types } from "mongoose";

import { CaptureMode, PaymentGatewayKey } from "@/lib/constants/enums";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Whether an organization's payments authorize-then-capture.
 *
 * `?? AUTOMATIC` is load-bearing: the resolvers read organizations with
 * `.lean()`, which does NOT apply Mongoose defaults, so a document stored
 * before `captureMode` existed — i.e. both incumbent brands' rows — arrives
 * with no such key and must read as AUTOMATIC.
 *
 * Manual capture is only ever enabled by an explicit, stored,
 * per-organization decision (`scripts/set-organization-capture-mode.ts`).
 * A null organizationId — an order stored before organizations existed —
 * takes the DEFAULT organization's decision: such an order belongs to the
 * default organization everywhere else too (it pays through the deployment
 * gateway, only the default organization's scope sees it, and the
 * deployment webhook endpoint accepts it), so a default organization on
 * MANUAL runs ONE lifecycle for all of its orders. With no default
 * organization, or none stored, it is AUTOMATIC.
 */
export async function getOrganizationCaptureMode(
  organizationId: string | null,
): Promise<CaptureMode> {
  await connectMongo();
  if (!organizationId) {
    const def = await Organization.findOne({ isDefault: true })
      .select("payments.captureMode")
      .lean<{ payments?: { captureMode?: CaptureMode } } | null>();
    return def?.payments?.captureMode ?? CaptureMode.AUTOMATIC;
  }
  if (!Types.ObjectId.isValid(organizationId)) {
    return CaptureMode.AUTOMATIC;
  }
  const org = await Organization.findById(organizationId)
    .select("payments.captureMode")
    .lean<{ payments?: { captureMode?: CaptureMode } } | null>();
  return org?.payments?.captureMode ?? CaptureMode.AUTOMATIC;
}

/** The processor an organization's next link opens when no other is picked:
 *  its configured provider, or the deployment's Stripe for an order stored
 *  without an organization (and for one that stores none). */
async function nextLinkGateway(organizationId: string | null): Promise<string> {
  if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
    return PaymentGatewayKey.STRIPE;
  }
  const org = await Organization.findById(organizationId)
    .select("payments.provider")
    .lean<{ payments?: { provider?: string | null } | null } | null>();
  return org?.payments?.provider ?? PaymentGatewayKey.STRIPE;
}

/**
 * Whether an order's checkout only AUTHORIZES the card — a hold an operator
 * captures later — instead of charging it. Every customer-facing sentence
 * about money before Capture keys off this.
 *
 * Once the order has a payment link the order says so itself:
 * `payment.capture`, pinned when that link was generated (null on every
 * automatic one). Before then — the composer's first preview — it is what
 * the next link will be: the organization on MANUAL and that link on
 * Stripe, the only processor manual capture applies to. (An operator who
 * picks another processor in the composer gets a link without a capture
 * record, and every render after it follows that link.)
 */
export async function paysByAuthorization(
  order: {
    payment: {
      capture?: { method?: string | null } | null;
      paymentUrl?: string | null;
      gateway?: string | null;
    };
  },
  organizationId: string | null,
): Promise<boolean> {
  const capture = order.payment.capture;
  if (capture) return capture.method === CaptureMode.MANUAL;
  if (order.payment.paymentUrl) return false;
  await connectMongo();
  if ((await getOrganizationCaptureMode(organizationId)) !== CaptureMode.MANUAL) {
    return false;
  }
  const gateway = order.payment.gateway ?? (await nextLinkGateway(organizationId));
  return gateway === PaymentGatewayKey.STRIPE;
}
