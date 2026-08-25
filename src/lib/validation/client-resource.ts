import { z } from "zod";

import {
  FILE_FILTERS,
  FILE_VISIBILITIES,
  LINK_FILTERS,
  MAX_FILE_UPLOAD_BYTES,
  parseResourceUrl,
} from "@/lib/constants/client-resources";

/** Mongo ObjectId hex. Routes take ids from the URL / body, so the
 *  shape check happens before any query is built. */
const objectId = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

/** "" / "none" / null all mean "no order relationship". The UI sends
 *  whichever is natural for its control; the server normalises once. */
const optionalOrderId = z
  .union([objectId, z.literal(""), z.literal("none"), z.null()])
  .optional()
  .transform((v) => (v && v !== "none" ? v : null));

const optionalDescription = z
  .string()
  .trim()
  .max(1000, "Keep the description under 1000 characters")
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

/* ─── Files ───────────────────────────────────────────────────────────── */

/** Query for GET /api/files. `customerId` OR `orderId` must be present —
 *  a list with neither would be a workspace-wide file browser, which is
 *  precisely the drive-shaped product this feature refuses to be. */
export const listClientFilesSchema = z
  .object({
    customerId: objectId.optional(),
    orderId: objectId.optional(),
    q: z.string().trim().max(200).optional(),
    filter: z.enum(FILE_FILTERS).default("all"),
  })
  .refine((v) => Boolean(v.customerId || v.orderId), {
    message: "A client or order scope is required",
    path: ["customerId"],
  });
export type ListClientFilesQuery = z.infer<typeof listClientFilesSchema>;

/** The non-binary half of the multipart upload body. */
export const createClientFileSchema = z.object({
  customerId: objectId,
  orderId: optionalOrderId,
  description: optionalDescription,
  visibility: z.enum(FILE_VISIBILITIES).default("INTERNAL"),
  /** The file came FROM the client (requirements, brand assets, a
   *  reference image) rather than from the team. Provenance only — the
   *  acting user is still stamped on the row, so this can be set by an
   *  operator recording a file the client emailed over. */
  uploadedByClient: z.boolean().optional().default(false),
});
export type CreateClientFileInput = z.infer<typeof createClientFileSchema>;

/** PATCH /api/files/[id]. Every field optional; only what's sent moves. */
export const updateClientFileSchema = z
  .object({
    description: optionalDescription,
    visibility: z.enum(FILE_VISIBILITIES).optional(),
    orderId: optionalOrderId,
  })
  .refine(
    (v) =>
      v.description !== undefined ||
      v.visibility !== undefined ||
      v.orderId !== undefined,
    { message: "Nothing to update" },
  );
export type UpdateClientFileInput = z.infer<typeof updateClientFileSchema>;

/** Guard used by both the route pre-flight and the service. Kept here so
 *  the browser can apply the identical rule before it spends the upload. */
export function exceedsUploadLimit(bytes: number): boolean {
  return bytes > MAX_FILE_UPLOAD_BYTES;
}

/* ─── Links ───────────────────────────────────────────────────────────── */

/** http(s) URL, normalised. Rejects `javascript:` / `data:` and anything
 *  without a real hostname before it can reach an `href`. */
const resourceUrl = z
  .string()
  .trim()
  .min(1, "Paste the URL")
  .max(2048, "That URL is too long")
  .refine((v) => parseResourceUrl(v) !== null, {
    message: "Enter a valid web address starting with http:// or https://",
  });

export const listClientLinksSchema = z
  .object({
    customerId: objectId.optional(),
    orderId: objectId.optional(),
    q: z.string().trim().max(200).optional(),
    filter: z.enum(LINK_FILTERS).default("all"),
  })
  .refine((v) => Boolean(v.customerId || v.orderId), {
    message: "A client or order scope is required",
    path: ["customerId"],
  });
export type ListClientLinksQuery = z.infer<typeof listClientLinksSchema>;

export const createClientLinkSchema = z.object({
  customerId: objectId,
  orderId: optionalOrderId,
  name: z
    .string()
    .trim()
    .min(1, "Give the link a name your team will recognise")
    .max(200),
  url: resourceUrl,
  description: optionalDescription,
  /** The client sent this resource over; we're recording it. Provenance
   *  only — the acting user is still stamped on the row. */
  addedByClient: z.boolean().optional().default(false),
});
export type CreateClientLinkInput = z.infer<typeof createClientLinkSchema>;

export const updateClientLinkSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    url: resourceUrl.optional(),
    description: optionalDescription,
    orderId: optionalOrderId,
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.url !== undefined ||
      v.description !== undefined ||
      v.orderId !== undefined,
    { message: "Nothing to update" },
  );
export type UpdateClientLinkInput = z.infer<typeof updateClientLinkSchema>;
