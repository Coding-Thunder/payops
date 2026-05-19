import { z } from "zod";

export const evidenceSearchFieldSchema = z.enum([
  "auto",
  "customerEmail",
  "paymentSessionId",
  "paymentIntentId",
  "transactionId",
  "gatewayEventId",
  "consentTokenHash",
  "signatureName",
  "messageId",
  "orderNumber",
]);
export type EvidenceSearchField = z.infer<typeof evidenceSearchFieldSchema>;

export const evidenceSearchSchema = z.object({
  q: z.string().trim().min(1).max(254),
  field: evidenceSearchFieldSchema.default("auto"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type EvidenceSearchInput = z.infer<typeof evidenceSearchSchema>;
