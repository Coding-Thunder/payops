import "server-only";

import { render } from "@react-email/render";

import { isSystemTemplateKey } from "@/lib/constants/email-templates";
import { renderVariables, sampleValues } from "@/lib/constants/email-variables";
import { env } from "@/lib/env";
import type { EmailTemplateContent } from "@/server/db/models";
import { CustomTemplateEmail } from "@/server/email/templates/custom-template-email";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
import {
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";

/**
 * The one function that turns a template draft into preview HTML.
 *
 * There used to be two: the editor PAGE rendered the first paint
 * server-side (correctly, branching on kind), and the preview ENDPOINT
 * re-rendered on every keystroke (incorrectly, defaulting everything
 * that wasn't `payment-request` to the Payment Confirmation layout).
 * The result was a preview that was right for one frame and then became
 * a payment receipt for a template about a meeting.
 *
 * Both callers now come here, so "first paint" and "after you typed"
 * are the same code path by construction rather than by discipline.
 */

export interface TemplatePreviewArgs {
  templateKey: string;
  /** Operator-facing name — the eyebrow on custom kinds. */
  displayName: string;
  /** The content being previewed: the editor's live draft, or the saved
   *  active version on first paint. */
  draft: Partial<EmailTemplateContent>;
  orgId: string | null | undefined;
  /** Copy shown when a brand-new template has nothing written yet, so
   *  the pane is never a blank white rectangle. */
  placeholder?: string;
}

export async function renderTemplatePreview(
  args: TemplatePreviewArgs,
): Promise<string> {
  const [branding, settings] = await Promise.all([
    getBranding(args.orgId),
    ensureSettingsDocument(args.orgId),
  ]);

  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  };

  if (isSystemTemplateKey(args.templateKey)) {
    // System kinds are code-rendered layouts with named copy slots. The
    // draft overrides the slots; the layout is fixed because that layout
    // is what the payment flow actually sends.
    const props =
      args.templateKey === "payment-request"
        ? buildPaymentRequestPreviewProps(baseArgs)
        : buildPaymentPreviewProps(baseArgs);
    return render(
      <UniversalOrderEmail
        {...props}
        greeting={args.draft.greeting ?? props.greeting}
        intro={args.draft.intro ?? props.intro}
        note={args.draft.note ?? props.note}
      />,
    );
  }

  // Custom kinds render through the same shell the send path uses.
  // Variables resolve against representative sample data: the editor has
  // no client in context, and a preview that shows raw `{{client_name}}`
  // teaches operators to distrust the preview.
  const samples = sampleValues();
  const sub = (text: string | null | undefined) =>
    text ? renderVariables(text, samples) : null;

  const body = sub(args.draft.body);
  const hasLegacyCopy = Boolean(
    args.draft.greeting || args.draft.intro || args.draft.note,
  );

  return render(
    <CustomTemplateEmail
      brandName={branding.brandName}
      eyebrow={args.displayName}
      preview={sub(args.draft.subject) ?? args.displayName}
      body={
        body ??
        (hasLegacyCopy
          ? null
          : (args.placeholder ??
            "Write your email on the left and it renders here, with sample client details filled in."))
      }
      // The legacy slot fields only render for templates saved before
      // `body` existed — a written body supersedes them entirely.
      greeting={body ? null : sub(args.draft.greeting)}
      intro={body ? null : sub(args.draft.intro)}
      note={body ? null : sub(args.draft.note)}
      supportEmail={branding.supportEmail || null}
      footerNote={sub(args.draft.footerNote)}
    />,
  );
}
