import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { Permission } from "@/lib/constants/permissions";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { env } from "@/lib/env";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
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
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);

  const body = await req.json().catch(() => ({}));
  const draft = createEmailTemplateVersionSchema.parse({
    subject: body?.subject,
    greeting: body?.greeting,
    intro: body?.intro,
    note: body?.note,
    supportHeadline: body?.supportHeadline,
    supportDescription: body?.supportDescription,
    footerNote: body?.footerNote,
  });

  // CRITICAL: pass actor.orgId so the preview reads THIS tenant's
  // branding + settings, not the legacy {key:"default"} singleton
  // which is seeded from env defaults ("Rental Confirmation",
  // "+1-555-0100", etc). Forgetting the orgId here was the exact
  // bug that made the preview pane flicker from the tenant brand
  // (SSR'd correctly with orgId in the page) to the env defaults
  // (this endpoint, called without orgId).
  const [branding, settings] = await Promise.all([
    getBranding(actor.orgId),
    ensureSettingsDocument(actor.orgId),
  ]);

  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
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
    html = await render(<UniversalOrderEmail {...merged} />);
  } else {
    const props = buildPaymentPreviewProps(baseArgs);
    html = await render(<UniversalOrderEmail {...props} />);
  }
  return jsonOk({ html });
});
