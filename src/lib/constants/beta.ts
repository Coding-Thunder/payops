/**
 * Beta program constants — shared by the public application form, the main
 * app's apply/activate endpoints, and the admin console's Beta Applications
 * section. Plain constants (no server-only imports) so the client form can
 * use the same labels/enums the server validates against.
 */

export const BetaApplicationStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  INVITED: "INVITED",
  ACTIVATED: "ACTIVATED",
} as const;
export type BetaApplicationStatus =
  (typeof BetaApplicationStatus)[keyof typeof BetaApplicationStatus];
export const BETA_APPLICATION_STATUSES = Object.values(
  BetaApplicationStatus,
) as BetaApplicationStatus[];

export const BetaUserType = {
  FREELANCER: "FREELANCER",
  AGENCY_OWNER: "AGENCY_OWNER",
  OTHER: "OTHER",
} as const;
export type BetaUserType = (typeof BetaUserType)[keyof typeof BetaUserType];
export const BETA_USER_TYPES = Object.values(BetaUserType) as BetaUserType[];

export const BetaUserTypeLabel: Record<BetaUserType, string> = {
  FREELANCER: "Freelancer",
  AGENCY_OWNER: "Agency Owner",
  OTHER: "Other",
};

/** Structured buckets for "how many clients do you manage?". Stored as the
 *  raw string so the admin sees exactly what the applicant selected. */
export const BETA_CLIENTS_MANAGED_OPTIONS = [
  "Just me",
  "1–5",
  "6–20",
  "21–50",
  "50+",
] as const;

/** The optional open-ended question shown on the form + in the admin detail. */
export const BETA_CHALLENGE_QUESTION =
  "What's the hardest part of keeping track of your clients today?";

/** Invitation lifetime. */
export const BETA_INVITE_TTL_DAYS = 7;
