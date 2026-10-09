import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import {
  BOOKING_TYPES,
  BookingType,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";
import { ValidationError } from "@/lib/errors";
import {
  createEmailTemplateVersionSchema,
  templateKeyParam,
} from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { previewServicesFor, renderEmailPreview } from "@/server/email/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/** The service to preview — required: a preview never guesses it. */
const previewServiceSchema = z.enum(SERVICE_TYPES as [ServiceType, ...ServiceType[]], {
  error: "Choose the service to preview: car rental, flight or hotel.",
});

/**
 * Render the chosen email template with the editor's current draft
 * overrides — without saving anything to Mongo. Powers the admin
 * editor's live preview pane.
 *
 * Body shape is the same as POST /api/admin/email-templates/[key]
 * (createEmailTemplateVersionSchema) so the same form can hit both
 * endpoints, plus the preview context: `serviceType` (REQUIRED — the service
 * whose sample booking and Terms & Conditions to show), and the optional
 * `provider` and `bookingType`.
 *
 * The terms are the SELECTED organization's own for that service, through
 * the same resolver a real order of that service freezes them with
 * (`renderEmailPreview` → `resolveServiceTerms`). A service the
 * organization does not sell is refused, like everywhere else.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);

  const body = await req.json().catch(() => ({}));
  // Strip the preview-context keys out before schema parse (those control
  // sample data, not template content).
  const draft = createEmailTemplateVersionSchema.parse({
    subject: body?.subject,
    greeting: body?.greeting,
    intro: body?.intro,
    note: body?.note,
    supportHeadline: body?.supportHeadline,
    supportDescription: body?.supportDescription,
    footerNote: body?.footerNote,
  });
  const serviceType = previewServiceSchema.parse(body?.serviceType);

  const organization = await getSelectedOrganization();
  const services = await previewServicesFor(organization?.id ?? null);
  if (!services.includes(serviceType)) {
    throw new ValidationError(
      `${organization?.brandName ?? "This organization"} does not sell ${ServiceTypeLabel[serviceType].toLowerCase()}, so there is no ${ServiceTypeLabel[serviceType].toLowerCase()} email to preview.`,
    );
  }
  await ensureSettingsDocument();

  const bookingType = (
    BOOKING_TYPES as readonly string[]
  ).includes(body?.bookingType ?? "")
    ? (body.bookingType as BookingType)
    : BookingType.NEW_BOOKING;

  const { html } = await renderEmailPreview({
    organizationId: organization?.id ?? null,
    serviceType,
    templateKey,
    providerKey: typeof body?.provider === "string" ? body.provider : null,
    bookingType,
    draft: {
      greeting: draft.greeting,
      intro: draft.intro,
      note: draft.note,
    },
  });
  return jsonOk({ html });
});
