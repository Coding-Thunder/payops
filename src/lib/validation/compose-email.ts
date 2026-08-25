import { z } from "zod";

const objectId = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

const optionalOrderId = z
  .union([objectId, z.literal(""), z.literal("none"), z.null()])
  .optional()
  .transform((v) => (v && v !== "none" ? v : null));

/**
 * One free-form email written in the client composer.
 *
 * `templateKey` is provenance, not behaviour: by the time this arrives
 * the template has already been expanded into `subject` + `body` in the
 * editor, and the operator may have rewritten every word of it. The
 * server renders exactly what it is given. That is the whole fix for the
 * "preview shows a different email than the one that sends" bug — there
 * is one source of truth (this payload) and every surface reads it.
 *
 * `variables` carries ONLY the operator-supplied (`manual`) fills such as
 * a meeting link or a date. Client / business / order / payment values
 * are never accepted from the browser — the server resolves those from
 * its own records so a tampered payload can't put another tenant's data
 * into an email.
 */
const composeBase = z.object({
  customerId: objectId,
  orderId: optionalOrderId,
  subject: z
    .string()
    .trim()
    .min(1, "Add a subject")
    .max(200, "Keep the subject under 200 characters"),
  body: z
    .string()
    .trim()
    .min(1, "Write your message")
    .max(20_000, "That message is too long to send"),
  /** Which template seeded the draft, when one did. Recorded on the
   *  audit + evidence rows so "what did we actually send" is answerable. */
  templateKey: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  /** Operator-supplied fills for `manual` variables only. */
  variables: z
    .record(z.string().trim().max(64), z.string().max(2000))
    .optional()
    .default({}),
  /** Existing ClientFile ids to attach. Resolved + tenant-checked
   *  server-side; the browser never uploads bytes with the send. */
  attachmentFileIds: z.array(objectId).max(10).optional().default([]),
  /** Existing ClientLink ids to append as a resources block. */
  linkIds: z.array(objectId).max(20).optional().default([]),
});

export const composeEmailSchema = composeBase.extend({
  to: z
    .string()
    .trim()
    .toLowerCase()
    .email("Recipient must be a valid email address")
    .max(254),
});
export type ComposeEmailInput = z.infer<typeof composeEmailSchema>;

/** Same shape minus the recipient — the preview never sends. */
export const previewComposedEmailSchema = composeBase;
export type PreviewComposedEmailInput = z.infer<
  typeof previewComposedEmailSchema
>;
