export { User } from "./user.model";
export type { UserDoc, UserDocument } from "./user.model";

export {
  Organization,
  ORG_STATUSES,
  ORG_SLUG_REGEX,
  OrgStatus,
} from "./organization.model";
export type {
  OrganizationDoc,
  OrganizationDocument,
} from "./organization.model";

export { OrgMember } from "./org-member.model";
export type { OrgMemberDoc, OrgMemberDocument } from "./org-member.model";

export { Workflow } from "./workflow.model";
export type {
  WorkflowDoc,
  WorkflowDocument,
  WorkflowStatusSpec,
  WorkflowTransitionSpec,
} from "./workflow.model";

export {
  Document,
  DocumentSequence,
  DocumentKind,
  DOCUMENT_KINDS,
} from "./document.model";
export type {
  DocumentDoc,
  DocumentDocument,
  DocumentSnapshot,
  DocumentSequenceDoc,
} from "./document.model";

export {
  GatewayCredential,
  GatewayMode,
  GATEWAY_MODES,
} from "./gateway-credential.model";
export type {
  EncryptedField,
  GatewayCredentialDoc,
  GatewayCredentialDocument,
} from "./gateway-credential.model";

export { Order } from "./order.model";
export type {
  OrderDoc,
  OrderDocument,
  OrderLineItem,
  OrderScheduling,
} from "./order.model";

export { ItemType } from "./item-type.model";
export type {
  ItemAttributeSpec,
  ItemTypeDoc,
  ItemTypeDocument,
} from "./item-type.model";

export { Item } from "./item.model";
export type {
  ItemDoc,
  ItemDocument,
  ItemInventorySnapshot,
  ItemPrice,
} from "./item.model";

export { Customer } from "./customer.model";
export type { CustomerDoc, CustomerDocument } from "./customer.model";

// Provider + CarLink models removed in Pass 5h.

export { Branding, BRANDING_KEY } from "./branding.model";
export type { BrandingDoc, BrandingDocument } from "./branding.model";

export { Setting, SETTINGS_KEY } from "./setting.model";
export type { SettingDoc, SettingDocument } from "./setting.model";

export { AuditLog } from "./audit-log.model";
export type { AuditLogDoc, AuditLogDocument } from "./audit-log.model";

export { OrderDraft } from "./order-draft.model";
export type { OrderDraftDoc, OrderDraftDocument } from "./order-draft.model";

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
