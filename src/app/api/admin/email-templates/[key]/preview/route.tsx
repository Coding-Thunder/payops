import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { Permission } from "@/lib/constants/permissions";
import {
  BOOKING_TYPES,
  BookingType,
} from "@/lib/constants/enums";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { env } from "@/lib/env";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";
import { PaymentConfirmationEmail } from "@/server/email/templates/payment-confirmation";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";
import {
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/**
 * Render the chosen email template with the editor's current draft
 * overrides — without saving anything to Mongo. Powers the admin
 * editor's live preview pane.
 *
 * Body shape is the same as POST /api/admin/email-templates/[key]
 * (createEmailTemplateVersionSchema) so the same form can hit both
 * endpoints.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);

  const body = await req.json().catch(() => ({}));
  // Strip the optional `provider` and `bookingType` keys out before
  // schema parse (those control sample data, not template content).
  const draft = createEmailTemplateVersionSchema.parse({
    subject: body?.subject,
    greeting: body?.greeting,
    intro: body?.intro,
    note: body?.note,
    supportHeadline: body?.supportHeadline,
    supportDescription: body?.supportDescription,
    footerNote: body?.footerNote,
  });

  const [branding, settings, providers] = await Promise.all([
    getBranding(),
    ensureSettingsDocument(),
    listActiveProviders(),
  ]);
  const providerKey =
    typeof body?.provider === "string" ? body.provider : undefined;
  const provider =
    providers.find((p) => p.key === providerKey) ?? providers[0] ?? null;
  if (!provider) {
    return jsonOk({ html: "" });
  }
  const bookingType = (
    BOOKING_TYPES as readonly string[]
  ).includes(body?.bookingType ?? "")
    ? (body.bookingType as BookingType)
    : BookingType.NEW_BOOKING;

  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    provider: {
      id: provider.key,
      name: provider.name,
      logo: provider.logo,
      primaryColor: provider.primaryColor,
      onPrimaryColor: provider.onPrimaryColor,
    },
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
    bookingType,
  };

  // Overlay the draft content onto the template's sample preview props
  // so the admin sees a fully-rendered email with their changes baked
  // in instead of just the editable fields in isolation.
  let html = "";
  if (templateKey === "payment-request") {
    const props = buildPaymentRequestPreviewProps(baseArgs);
    const merged = {
      ...props,
      greeting: draft.greeting ?? props.greeting,
      intro: draft.intro ?? props.intro,
      note: draft.note ?? props.note,
    };
    html = await render(<PaymentRequestEmail {...merged} />);
  } else {
    // payment-confirmation
    const props = buildPaymentPreviewProps(baseArgs);
    html = await render(<PaymentConfirmationEmail {...props} />);
  }
  return jsonOk({ html });
});
