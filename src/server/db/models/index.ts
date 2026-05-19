export { User } from "./user.model";
export type { UserDoc, UserDocument } from "./user.model";

export { Order } from "./order.model";
export type { OrderDoc, OrderDocument } from "./order.model";

export { Provider } from "./provider.model";
export type { ProviderDoc, ProviderDocument } from "./provider.model";

export { Branding, BRANDING_KEY } from "./branding.model";
export type { BrandingDoc, BrandingDocument } from "./branding.model";

export { Setting, SETTINGS_KEY } from "./setting.model";
export type { SettingDoc, SettingDocument } from "./setting.model";

export { AuditLog } from "./audit-log.model";
export type { AuditLogDoc, AuditLogDocument } from "./audit-log.model";

export { OrderDraft } from "./order-draft.model";
export type { OrderDraftDoc, OrderDraftDocument } from "./order-draft.model";

export { CarLink } from "./car-link.model";
export type { CarLinkDoc, CarLinkDocument } from "./car-link.model";

export {
  EmailTemplate,
  EMAIL_TEMPLATE_KEYS,
} from "./email-template.model";
export type {
  EmailTemplateContent,
  EmailTemplateDoc,
  EmailTemplateDocument,
  EmailTemplateKey,
} from "./email-template.model";

export { PaymentConsent } from "./payment-consent.model";
export type {
  PaymentConsentDoc,
  PaymentConsentDocument,
} from "./payment-consent.model";

export { OrderEvidence } from "./order-evidence.model";
export type {
  OrderEvidenceActor,
  OrderEvidenceDoc,
  OrderEvidenceDocument,
  OrderEvidenceRefs,
  OrderEvidenceRequest,
} from "./order-evidence.model";

export { Dispute } from "./dispute.model";
export type { DisputeDoc, DisputeDocument } from "./dispute.model";

export { Quotation } from "./quotation.model";
export type { QuotationDoc, QuotationDocument } from "./quotation.model";

export {
  ProcessedWebhookEvent,
  PendingEmail,
  PendingEmailStatus,
} from "./outbox.model";
export type {
  ProcessedWebhookEventDoc,
  ProcessedWebhookEventDocument,
  PendingEmailDoc,
  PendingEmailDocument,
} from "./outbox.model";
