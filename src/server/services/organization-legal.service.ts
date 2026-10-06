import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  ServiceType,
  type UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { isEqual, nextPolicyVersion } from "@/lib/policy-version";
import type { UpdateServiceLegalInput } from "@/lib/validation";
import {
  Organization,
  type OrganizationServiceLegal,
} from "@/server/db/models";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { connectMongo } from "@/server/db/mongoose";
import { organizationStamp } from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

/**
 * An organization's own FLIGHT terms and cancellation policy
 * (`legal.services.FLIGHT`), edited in Admin → Settings → Flight terms.
 *
 * Organization-scoped on purpose, unlike everything else on that page. The
 * Settings singleton is shared by every brand, so a flight text stored there
 * would let one brand's legal wording reach another brand's flights. An
 * organization with no text of its own freezes the built-in flight default
 * onto its flight orders — never its car-rental text, and never the
 * singleton (see `resolveFlightLegal` in order.service.ts).
 */

export interface OrganizationFlightLegal {
  organizationId: string;
  brandName: string;
  /** Whether FLIGHT is one of the organization's service types. The form
   *  is only offered, and a save only accepted, when it is. */
  sellsFlight: boolean;
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
  /** True when the organization has no text of its own, so the text and
   *  version above are the built-in default's. */
  termsIsDefault: boolean;
  policyIsDefault: boolean;
  /**
   * True when the organization has organization-wide (top-level) legal
   * text. Car rental and hotel orders use it; flight orders never do — and
   * before per-service text existed, that is where a flight brand's terms
   * were written. The editor says so, so wording left there is not
   * mistaken for the flight terms in force.
   */
  hasOrganizationWideText: boolean;
}

interface UpdateOrganizationLegalContext {
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  request?: RequestContext | null;
}

interface OrganizationLegalRow {
  _id: Types.ObjectId;
  brandName: string;
  serviceTypes?: ServiceType[] | null;
  legal?: {
    termsAndConditions?: string | null;
    cancellationPolicy?: string | null;
    services?: { FLIGHT?: Partial<OrganizationServiceLegal> | null } | null;
  } | null;
}

const FLIGHT_LEGAL_FIELDS =
  "brandName serviceTypes legal.termsAndConditions legal.cancellationPolicy legal.services.FLIGHT";

/** What an organization stores for its flight legal text, as read back —
 *  any field may be missing, empty or (on an old document) null. */
export interface StoredFlightLegal {
  termsAndConditions?: string | null;
  termsVersion?: string | null;
  cancellationPolicy?: string | null;
  cancellationPolicyVersion?: string | null;
}

/** The flight terms and policy in force, each with the version it travels
 *  with, and whether it is the built-in default. */
export interface PairedFlightLegal {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
  termsIsDefault: boolean;
  policyIsDefault: boolean;
}

/**
 * THE flight T&C pairing rule — the only place it lives. Each text travels
 * with its OWN version: the organization's own (trimmed) text with its own
 * version, or "v1" when it stored none; otherwise the built-in
 * `DEFAULT_FLIGHT_*` text with `DEFAULT_FLIGHT_LEGAL_VERSION`. Never empty.
 *
 * Pure, and shared by the admin form (`toView`) and `resolveFlightLegal` in
 * order.service.ts, so the form always shows exactly what the next flight
 * order freezes.
 */
export function pairFlightLegal(
  own: StoredFlightLegal | null | undefined,
): PairedFlightLegal {
  const terms = own?.termsAndConditions?.trim();
  const policy = own?.cancellationPolicy?.trim();
  return {
    termsAndConditions: terms || DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    termsVersion: terms
      ? own?.termsVersion?.trim() || "v1"
      : DEFAULT_FLIGHT_LEGAL_VERSION,
    cancellationPolicy: policy || DEFAULT_FLIGHT_CANCELLATION_POLICY,
    cancellationPolicyVersion: policy
      ? own?.cancellationPolicyVersion?.trim() || "v1"
      : DEFAULT_FLIGHT_LEGAL_VERSION,
    termsIsDefault: !terms,
    policyIsDefault: !policy,
  };
}

/** Resolved by `pairFlightLegal`, exactly as a new flight order resolves it. */
function toView(org: OrganizationLegalRow): OrganizationFlightLegal {
  return {
    organizationId: String(org._id),
    brandName: org.brandName,
    // An absent list reads as [CAR_RENTAL], so it never includes FLIGHT.
    sellsFlight: (org.serviceTypes ?? []).includes(ServiceType.FLIGHT),
    ...pairFlightLegal(org.legal?.services?.FLIGHT),
    hasOrganizationWideText: Boolean(
      org.legal?.termsAndConditions?.trim() ||
        org.legal?.cancellationPolicy?.trim(),
    ),
  };
}

export async function getOrganizationFlightLegal(
  organizationId: string | Types.ObjectId,
): Promise<OrganizationFlightLegal> {
  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select(FLIGHT_LEGAL_FIELDS)
    .lean<OrganizationLegalRow | null>();
  if (!org) throw new NotFoundError("Organization not found");
  return toView(org);
}

/**
 * Save the SELECTED organization's flight terms and cancellation policy.
 *
 * The organization comes only from the request's organization scope — the
 * selected-org cookie, validated against the caller's memberships — so an
 * admin can only ever change the brand they are working in. Orders already
 * created keep the text and version they froze.
 */
export async function updateOrganizationFlightLegal(
  input: UpdateServiceLegalInput,
  ctx: UpdateOrganizationLegalContext,
): Promise<OrganizationFlightLegal> {
  const organizationId = organizationStamp(await getRequestOrganizationScope());
  if (!organizationId) {
    throw new ForbiddenError("Select an organization to continue");
  }

  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select(FLIGHT_LEGAL_FIELDS)
    .lean<OrganizationLegalRow | null>();
  if (!org) throw new NotFoundError("Organization not found");

  const current = toView(org);
  if (!current.sellsFlight) {
    throw new ValidationError(
      `${current.brandName} does not sell flights, so it has no flight terms to set.`,
    );
  }

  // Stale-tab guards. The organization above came from the selection
  // cookie; the editor says which one it was showing. A tab opened for one
  // brand must never save into another selected since, nor silently undo a
  // newer edit of the same brand's text.
  if (
    input.expectedOrganizationId &&
    input.expectedOrganizationId !== String(organizationId)
  ) {
    throw new ConflictError(
      "You switched brand in another tab. Reload this page before saving.",
    );
  }
  if (
    (input.expectedTermsVersion &&
      input.expectedTermsVersion !== current.termsVersion) ||
    (input.expectedCancellationPolicyVersion &&
      input.expectedCancellationPolicyVersion !==
        current.cancellationPolicyVersion)
  ) {
    throw new ConflictError(
      "These flight terms changed since you opened this page. Reload to see the latest version before saving.",
    );
  }

  // Diffed against the text new flight orders freeze today — the
  // organization's own, or the built-in default it is still on. A field
  // saved untouched therefore stays on the default and keeps its version;
  // only a text that really changed is written, re-versioned and audited.
  const stored = org.legal?.services?.FLIGHT ?? null;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const next: Partial<OrganizationServiceLegal> = {};

  // Versions bump from the STORED label — the same rule as the deployment
  // settings — and from "v1", the built-in default's, when there is none.
  // An organization's first text of its own is therefore "v2".
  if (!isEqual(current.termsAndConditions, input.termsAndConditions)) {
    const bumped = nextPolicyVersion(
      stored?.termsVersion?.trim() || DEFAULT_FLIGHT_LEGAL_VERSION,
    );
    next.termsAndConditions = input.termsAndConditions;
    next.termsVersion = bumped;
    changes.termsAndConditions = {
      from: current.termsAndConditions,
      to: input.termsAndConditions,
    };
    changes.termsVersion = { from: current.termsVersion, to: bumped };
  }

  if (!isEqual(current.cancellationPolicy, input.cancellationPolicy)) {
    const bumped = nextPolicyVersion(
      stored?.cancellationPolicyVersion?.trim() || DEFAULT_FLIGHT_LEGAL_VERSION,
    );
    next.cancellationPolicy = input.cancellationPolicy;
    next.cancellationPolicyVersion = bumped;
    changes.cancellationPolicy = {
      from: current.cancellationPolicy,
      to: input.cancellationPolicy,
    };
    changes.cancellationPolicyVersion = {
      from: current.cancellationPolicyVersion,
      to: bumped,
    };
  }

  if (Object.keys(next).length === 0) {
    throw new ValidationError("No changes to apply");
  }

  // `$set` creates missing parents but cannot write THROUGH a stored null,
  // and Mongoose stores both `legal.services` and `services.FLIGHT` as null
  // by default on a new document. So: just the changed fields when the
  // FLIGHT block exists, otherwise the whole block — with an untouched text
  // left empty, i.e. still on the built-in default.
  const set: Record<string, unknown> = {
    updatedBy: new Types.ObjectId(ctx.actorId),
  };
  if (stored) {
    for (const [field, value] of Object.entries(next)) {
      set[`legal.services.FLIGHT.${field}`] = value;
    }
  } else {
    const block: OrganizationServiceLegal = {
      termsAndConditions: "",
      termsVersion: "",
      cancellationPolicy: "",
      cancellationPolicyVersion: "",
      ...next,
    };
    if (org.legal?.services) set["legal.services.FLIGHT"] = block;
    else set["legal.services"] = { FLIGHT: block };
  }

  const updated = await Organization.findByIdAndUpdate(
    organizationId,
    { $set: set },
    { returnDocument: "after" },
  )
    .select(FLIGHT_LEGAL_FIELDS)
    .lean<OrganizationLegalRow | null>();
  if (!updated) throw new NotFoundError("Organization not found");

  await recordAudit({
    action: AuditAction.ORGANIZATION_LEGAL_UPDATED,
    entityType: AuditEntity.ORGANIZATION,
    entityId: String(organizationId),
    actor: {
      userId: ctx.actorId,
      name: ctx.actorName,
      role: ctx.actorRole,
    },
    request: ctx.request ?? null,
    metadata: { serviceType: ServiceType.FLIGHT, changes },
    // Explicit rather than ambient: the row belongs to the brand whose
    // terms changed.
    organizationId,
  });

  return toView(updated);
}
