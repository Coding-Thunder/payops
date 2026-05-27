import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { Permission } from "@/lib/constants/permissions";
import { z } from "zod";

import { BUSINESS_VERTICALS } from "@/lib/constants/business-templates";
import { env } from "@/lib/env";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
import { buildPaymentPreviewProps } from "@/server/email/preview-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewQuerySchema = z.object({
  vertical: z.enum(BUSINESS_VERTICALS).optional(),
});

/**
 * Pass 6b — GET /api/onboarding/business-setup/preview-email
 *
 * Renders the confirmation email a customer would receive once the
 * wizard's ItemType is saved + an order is paid against it. Uses the
 * same `buildPaymentPreviewProps` helper that powers the admin
 * email-templates preview pane — we don't ship a vertical-specific
 * synthetic order yet because the universal template already
 * gracefully degrades for any line-item shape.
 *
 * Returned `{ html }` is dropped into an `<iframe srcDoc=…>` in the
 * wizard's step 4 preview pane.
 *
 * Read-only — no DB writes. Gated by `ITEM_TYPE_VIEW` so any staff
 * member who can preview the wizard can also see the resulting email.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ITEM_TYPE_VIEW);
  const url = new URL(req.url);
  previewQuerySchema.parse({
    vertical: url.searchParams.get("vertical") ?? undefined,
  });
  const [branding, settings] = await Promise.all([
    getBranding(actor.orgId),
    ensureSettingsDocument(actor.orgId),
  ]);
  const props = buildPaymentPreviewProps({
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  });
  const html = await render(<UniversalOrderEmail {...props} />);
  return jsonOk({ html });
});
