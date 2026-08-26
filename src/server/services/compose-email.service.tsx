import "server-only";

import { render } from "@react-email/render";

import {
  MAX_EMAIL_ATTACHMENT_TOTAL_BYTES,
  formatFileSize,
} from "@/lib/constants/client-resources";
import { renderVariables } from "@/lib/constants/email-variables";
import {
  AuditAction,
  AuditEntity,
  EmailKind,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  type UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import type {
  ComposeEmailInput,
  PreviewComposedEmailInput,
} from "@/lib/validation";
import { CustomTemplateEmail } from "@/server/email/templates/custom-template-email";
import { getBranding } from "@/server/services/branding.service";
import {
  loadAttachments,
  markFilesEmailed,
} from "@/server/services/client-file.service";
import {
  loadLinksForEmail,
  markLinksEmailed,
} from "@/server/services/client-link.service";
import { resolveEmailContext } from "@/server/services/email-context.service";
import { sendComposedMessage } from "@/server/services/email.service";
import { captureEvidenceSafe } from "@/server/services/evidence.service";
import { recordAudit } from "@/server/services/audit.service";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter } from "@/server/db/org/org-context";
import { Types } from "mongoose";

/**
 * The composed-email pipeline — ONE path from a draft to pixels.
 *
 * This module exists to kill a specific class of bug: the preview
 * showing a different email than the one that sends. Previously the
 * preview endpoint chose a renderer by guessing from the template key
 * (and defaulted every unrecognised key to the Payment Confirmation
 * layout), while the send path rendered something else entirely. Here
 * `buildComposedEmail` is the only place a composed message becomes
 * HTML, and BOTH `previewComposedEmail` and `sendComposedEmail` call it
 * with the same inputs. If the preview is wrong, the sent mail is wrong
 * in exactly the same way — which is the property that makes a preview
 * worth having.
 */

export interface ComposeActorCtx {
  actor: { id: string; name: string; email: string; role: UserRole };
  orgId: string;
  request?: RequestContext | null;
}

interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
  /** Resolved copy, for the audit/evidence record — what actually went. */
  body: string;
  attachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }>;
  links: Array<{ id: string; name: string; url: string; source: string }>;
  orderId: string | null;
}

/** Resolve variables, gather attachments + links, render the shell. */
async function buildComposedEmail(
  input: PreviewComposedEmailInput & { attachmentFileIds?: string[] },
  ctx: ComposeActorCtx,
  options: { loadBytes: boolean },
): Promise<BuiltEmail> {
  const [context, branding] = await Promise.all([
    resolveEmailContext({
      orgId: ctx.orgId,
      customerId: input.customerId,
      orderId: input.orderId ?? null,
      actorName: ctx.actor.name,
      manual: input.variables ?? {},
    }),
    getBranding(ctx.orgId),
  ]);

  const subject = renderVariables(input.subject, context.values).trim();
  const body = renderVariables(input.body, context.values).trim();
  if (!subject) throw new ValidationError("Add a subject before sending.");
  if (!body) throw new ValidationError("Write your message before sending.");

  // Links are inserted INLINE by the composer, so they already live in
  // `body`. Loading them here is about provenance, not rendering: it
  // tenant-checks the ids and gives the send path something to stamp as
  // "shared via email".
  const links = await loadLinksForEmail(
    input.linkIds ?? [],
    ctx.orgId,
    input.customerId,
  );

  // The preview doesn't need the bytes — only the names — so it skips
  // pulling megabytes out of GridFS on every keystroke.
  const attachments = options.loadBytes
    ? await loadAttachments(
        input.attachmentFileIds ?? [],
        ctx.orgId,
        input.customerId,
      )
    : [];

  if (options.loadBytes) {
    const total = attachments.reduce((sum, a) => sum + a.bytes.byteLength, 0);
    if (total > MAX_EMAIL_ATTACHMENT_TOTAL_BYTES) {
      throw new ValidationError(
        `Those attachments total ${formatFileSize(total)}, over the ${formatFileSize(
          MAX_EMAIL_ATTACHMENT_TOTAL_BYTES,
        )} limit for one email. Send fewer files, or share the large ones as links.`,
      );
    }
  }

  const element = (
    <CustomTemplateEmail
      brandName={branding.brandName}
      eyebrow={subject}
      preview={subject}
      body={body}
      supportEmail={branding.supportEmail || null}
    />
  );

  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);

  return {
    subject,
    html,
    text,
    body,
    attachments,
    links: links.map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      source: l.source,
    })),
    orderId: context.order?.id ?? null,
  };
}

/**
 * Render the draft exactly as it would send, without sending.
 *
 * Attachment BYTES are skipped (names are enough for a preview), but
 * every other input — resolved variables, shared links, the shell — is
 * identical to the send path because it's the same function.
 */
export async function previewComposedEmail(
  input: PreviewComposedEmailInput,
  ctx: ComposeActorCtx,
): Promise<{ html: string; subject: string }> {
  const built = await buildComposedEmail(input, ctx, { loadBytes: false });
  return { html: built.html, subject: built.subject };
}

export interface ComposedSendResult {
  id: string | null;
  subject: string;
  attachmentCount: number;
  linkCount: number;
}

/**
 * Send the composed message, then wire it into the client record:
 * attachments and links are stamped as shared (which is what puts them
 * in the "Sent via email" filter and on the Timeline), the order —
 * when there is one — gets an evidence row, and the audit trail records
 * what went where.
 *
 * Order of operations is deliberate: the provenance writes happen AFTER
 * a confirmed send. A failed send must not leave a file claiming it was
 * emailed to a client who never received it.
 */
export async function sendComposedEmail(
  input: ComposeEmailInput,
  ctx: ComposeActorCtx,
): Promise<ComposedSendResult> {
  const built = await buildComposedEmail(input, ctx, { loadBytes: true });
  const branding = await getBranding(ctx.orgId);

  const sent = await sendComposedMessage({
    to: input.to,
    subject: built.subject,
    html: built.html,
    text: built.text,
    orderId: built.orderId,
    brandName: branding.brandName,
    supportEmail: branding.supportEmail || null,
    senderEmail: branding.senderEmail || null,
    attachments: built.attachments.map((a) => ({
      fileName: a.fileName,
      content: a.bytes,
      contentType: a.mimeType,
    })),
  });

  const fileIds = built.attachments.map((a) => a.id);
  const linkIds = built.links.map((l) => l.id);
  await Promise.all([
    markFilesEmailed(fileIds, ctx),
    markLinksEmailed(linkIds, ctx),
  ]);

  await recordAudit({
    action: AuditAction.EMAIL_SENT,
    entityType: AuditEntity.CUSTOMER,
    entityId: input.customerId,
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      kind: EmailKind.CLIENT_MESSAGE,
      to: input.to,
      subject: built.subject,
      templateKey: input.templateKey,
      orderId: built.orderId,
      attachments: fileIds,
      links: linkIds,
      messageId: sent.id,
    },
  });

  // Evidence chain: a message sent against an order is a touchpoint a
  // future chargeback needs to see, attachments included.
  if (built.orderId) {
    const orderNumber = await lookupOrderNumber(ctx.orgId, built.orderId);
    await captureEvidenceSafe({
      orderId: built.orderId,
      orderNumber,
      eventType: OrderEvidenceEventType.CLIENT_MESSAGE_SENT,
      actor: {
        type: OrderEvidenceActorType.AGENT,
        userId: ctx.actor.id,
        name: ctx.actor.name,
        email: ctx.actor.email,
        role: ctx.actor.role,
      },
      request: ctx.request ?? null,
      payload: {
        channel: "client-composer",
        templateKey: input.templateKey,
        subject: built.subject,
        recipient: input.to,
        messageId: sent.id,
        attachments: built.attachments.map((a) => a.fileName),
        links: built.links.map((l) => l.url),
      },
      refs: {
        customerEmail: input.to,
        messageId: sent.id ?? null,
      },
    });
  }

  return {
    id: sent.id,
    subject: built.subject,
    attachmentCount: fileIds.length,
    linkCount: linkIds.length,
  };
}

async function lookupOrderNumber(
  orgId: string,
  orderId: string,
): Promise<string> {
  await connectMongo();
  if (!Types.ObjectId.isValid(orderId)) return "—";
  const doc = await Order.findOne({
    _id: new Types.ObjectId(orderId),
    orgId: orgIdFilter(orgId),
  })
    .select({ orderNumber: 1 })
    .lean<{ orderNumber?: string }>();
  return doc?.orderNumber ?? "—";
}
