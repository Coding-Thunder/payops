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
import type {
  OrganizationLegalService,
  ServiceWithOwnLegal,
  UpdateServiceLegalInput,
} from "@/lib/validation";
import {
  Organization,
  type OrganizationServiceLegal,
} from "@/server/db/models";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_HOTEL_CANCELLATION_POLICY,
  DEFAULT_HOTEL_LEGAL_VERSION,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { connectMongo } from "@/server/db/mongoose";
import { organizationStamp } from "@/server/db/organization-filter";
import {
  getRequestOrganizationScope,
  getSelectedOrganization,
} from "@/server/auth/organization";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";
import { serviceTypesOrDefault } from "./organization-service-types";
import { getSettings } from "./settings.service";

/**
 * An organization's OWN terms and cancellation policy for each service it
 * sells, edited in Admin → Settings:
 *
 *   - CAR_RENTAL — its top-level `legal` text. Until the organization saves
 *     its own, it inherits the deployment default (the Settings singleton),
 *     exactly as it always has.
 *   - FLIGHT / HOTEL — `legal.services.FLIGHT` / `legal.services.HOTEL`,
 *     else that service's built-in, brand-neutral default.
 *
 * Every save writes the SELECTED organization's own text for ONE service and
 * nothing else — never the deployment default, never another brand's text,
 * never another service's. So one brand's edit can never reach another
 * brand's orders, and a service's text can never reach another service's
 * orders (see `resolveOrderLegal` in order.service.ts).
 */

/** How a refusal names each service. */
const SERVICE_COPY: Record<
  OrganizationLegalService,
  { notSold: (brandName: string) => string; staleEdit: string }
> = {
  [ServiceType.CAR_RENTAL]: {
    notSold: (brandName) =>
      `${brandName} does not sell car rental, so it has no car rental terms to set.`,
    staleEdit:
      "These car rental terms changed since you opened this page. Reload to see the latest version before saving.",
  },
  [ServiceType.FLIGHT]: {
    notSold: (brandName) =>
      `${brandName} does not sell flights, so it has no flight terms to set.`,
    staleEdit:
      "These flight terms changed since you opened this page. Reload to see the latest version before saving.",
  },
  [ServiceType.HOTEL]: {
    notSold: (brandName) =>
      `${brandName} does not sell hotel stays, so it has no hotel terms to set.`,
    staleEdit:
      "These hotel terms changed since you opened this page. Reload to see the latest version before saving.",
  },
};

/** Each service with a legal slot of its own: its built-in text. */
const SERVICE_DEFAULTS: Record<
  ServiceWithOwnLegal,
  { termsAndConditions: string; cancellationPolicy: string; version: string }
> = {
  [ServiceType.FLIGHT]: {
    termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
    version: DEFAULT_FLIGHT_LEGAL_VERSION,
  },
  [ServiceType.HOTEL]: {
    termsAndConditions: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
    cancellationPolicy: DEFAULT_HOTEL_CANCELLATION_POLICY,
    version: DEFAULT_HOTEL_LEGAL_VERSION,
  },
};

/** One service's legal text for one organization, as its editor shows it
 *  — which is exactly what that service's next order freezes. */
interface OrganizationServiceLegalView {
  organizationId: string;
  brandName: string;
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
  /** True when the organization has no text of its own, so the text and
   *  version above are the default's: the built-in one for flight and
   *  hotel, the inherited deployment default for car rental. */
  termsIsDefault: boolean;
  policyIsDefault: boolean;
  /**
   * Flight and hotel only: true when the organization has organization-wide
   * (top-level) legal text. Car rental orders use it; flight and hotel orders
   * never do — and before per-service text existed, that is where such a
   * brand's terms were written. The editor says so, so wording left there is
   * not mistaken for the terms in force. Always false for car rental, whose
   * own text that IS.
   */
  hasOrganizationWideText: boolean;
}

export interface OrganizationCarLegal extends OrganizationServiceLegalView {
  /** Whether CAR_RENTAL is one of the organization's service types. The
   *  form is only offered, and a save only accepted, when it is. */
  sellsCarRental: boolean;
}

export interface OrganizationFlightLegal extends OrganizationServiceLegalView {
  /** Whether FLIGHT is one of the organization's service types. The form
   *  is only offered, and a save only accepted, when it is. */
  sellsFlight: boolean;
}

export interface OrganizationHotelLegal extends OrganizationServiceLegalView {
  /** Whether HOTEL is one of the organization's service types. The form
   *  is only offered, and a save only accepted, when it is. */
  sellsHotel: boolean;
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
    termsVersion?: string | null;
    cancellationPolicy?: string | null;
    cancellationPolicyVersion?: string | null;
    services?: Partial<
      Record<ServiceWithOwnLegal, Partial<OrganizationServiceLegal> | null>
    > | null;
  } | null;
}

/** The deployment-wide car rental text: what a car rental order freezes for
 *  any field its organization has not set itself. */
export interface DeploymentCarLegal {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
}

/** What a view needs: the organization, its service list, its top-level
 *  text, and — for flight or hotel — that service's slot. */
function viewFields(serviceType: OrganizationLegalService): string {
  return serviceType === ServiceType.CAR_RENTAL
    ? "brandName serviceTypes legal.termsAndConditions legal.termsVersion legal.cancellationPolicy legal.cancellationPolicyVersion"
    : `brandName serviceTypes legal.termsAndConditions legal.cancellationPolicy legal.services.${serviceType}`;
}

async function deploymentCarLegal(): Promise<DeploymentCarLegal> {
  const settings = await getSettings();
  return {
    termsAndConditions: settings.termsAndConditions,
    termsVersion: settings.termsVersion,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  };
}

/** What an organization stores for one service's legal text, as read back
 *  — any field may be missing, empty or (on an old document) null. */
export interface StoredServiceLegal {
  termsAndConditions?: string | null;
  termsVersion?: string | null;
  cancellationPolicy?: string | null;
  cancellationPolicyVersion?: string | null;
}

/** One service's terms and policy in force, each with the version it
 *  travels with, and whether it is the built-in default. */
export interface PairedServiceLegal {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
  termsIsDefault: boolean;
  policyIsDefault: boolean;
}

/**
 * THE per-service T&C pairing rule — the only place it lives. Each text
 * travels with its OWN version: the organization's own (trimmed) text with
 * its own version, or "v1" when it stored none; otherwise the service's
 * built-in text with that built-in's version. Never empty.
 *
 * Pure, and shared by the admin form (`toServiceView`) and
 * `resolveOrderLegal` in order.service.ts, so the form always shows exactly
 * what the next order of that service freezes.
 */
export function pairServiceLegal(
  serviceType: ServiceWithOwnLegal,
  own: StoredServiceLegal | null | undefined,
): PairedServiceLegal {
  const builtIn = SERVICE_DEFAULTS[serviceType];
  const terms = own?.termsAndConditions?.trim();
  const policy = own?.cancellationPolicy?.trim();
  return {
    termsAndConditions: terms || builtIn.termsAndConditions,
    termsVersion: terms
      ? own?.termsVersion?.trim() || "v1"
      : builtIn.version,
    cancellationPolicy: policy || builtIn.cancellationPolicy,
    cancellationPolicyVersion: policy
      ? own?.cancellationPolicyVersion?.trim() || "v1"
      : builtIn.version,
    termsIsDefault: !terms,
    policyIsDefault: !policy,
  };
}

/**
 * THE car rental T&C rule — the only place it lives, and exactly the rule
 * car rental orders have always been frozen with: field by field, the
 * organization's own (trimmed) value, else the deployment default's. So an
 * organization can override only its terms and still inherit the deployment
 * policy. Never a flight or hotel text, never another organization's.
 *
 * Pure, and shared by the admin form and `resolveOrderLegal`, so the form
 * always shows exactly what the next car rental order freezes.
 */
export function pairCarLegal(
  own: StoredServiceLegal | null | undefined,
  deployment: DeploymentCarLegal,
): PairedServiceLegal {
  const terms = own?.termsAndConditions?.trim();
  const policy = own?.cancellationPolicy?.trim();
  return {
    termsAndConditions: terms || deployment.termsAndConditions,
    termsVersion: own?.termsVersion?.trim() || deployment.termsVersion,
    cancellationPolicy: policy || deployment.cancellationPolicy,
    cancellationPolicyVersion:
      own?.cancellationPolicyVersion?.trim() ||
      deployment.cancellationPolicyVersion,
    termsIsDefault: !terms,
    policyIsDefault: !policy,
  };
}

/** The flight pairing: `pairServiceLegal` for FLIGHT. The flight entry
 *  points (this, `getOrganizationFlightLegal`, `updateOrganizationFlightLegal`)
 *  keep their original contracts, so flight callers and tests are unchanged. */
export function pairFlightLegal(
  own: StoredServiceLegal | null | undefined,
): PairedServiceLegal {
  return pairServiceLegal(ServiceType.FLIGHT, own);
}

/** Whether the organization sells the service — the ONE service-type rule
 *  (`serviceTypesOrDefault`): an absent list reads as [CAR_RENTAL]. */
function sells(org: OrganizationLegalRow, serviceType: ServiceType): boolean {
  return serviceTypesOrDefault(org.serviceTypes).includes(serviceType);
}

/** Resolved exactly as a new order of that service resolves it. The
 *  deployment default is needed for car rental only. */
function toServiceView(
  org: OrganizationLegalRow,
  serviceType: OrganizationLegalService,
  deployment: DeploymentCarLegal | null,
): OrganizationServiceLegalView {
  if (serviceType === ServiceType.CAR_RENTAL) {
    return {
      organizationId: String(org._id),
      brandName: org.brandName,
      ...pairCarLegal(org.legal, deployment!),
      hasOrganizationWideText: false,
    };
  }
  return {
    organizationId: String(org._id),
    brandName: org.brandName,
    ...pairServiceLegal(serviceType, org.legal?.services?.[serviceType]),
    hasOrganizationWideText: Boolean(
      org.legal?.termsAndConditions?.trim() ||
        org.legal?.cancellationPolicy?.trim(),
    ),
  };
}

function toCarView(
  org: OrganizationLegalRow,
  deployment: DeploymentCarLegal,
): OrganizationCarLegal {
  return {
    ...toServiceView(org, ServiceType.CAR_RENTAL, deployment),
    sellsCarRental: sells(org, ServiceType.CAR_RENTAL),
  };
}

function toFlightView(org: OrganizationLegalRow): OrganizationFlightLegal {
  return {
    ...toServiceView(org, ServiceType.FLIGHT, null),
    sellsFlight: sells(org, ServiceType.FLIGHT),
  };
}

function toHotelView(org: OrganizationLegalRow): OrganizationHotelLegal {
  return {
    ...toServiceView(org, ServiceType.HOTEL, null),
    sellsHotel: sells(org, ServiceType.HOTEL),
  };
}

type AnyServiceLegalView =
  | OrganizationCarLegal
  | OrganizationFlightLegal
  | OrganizationHotelLegal;

function toView(
  org: OrganizationLegalRow,
  serviceType: OrganizationLegalService,
  deployment: DeploymentCarLegal | null,
): AnyServiceLegalView {
  if (serviceType === ServiceType.CAR_RENTAL) return toCarView(org, deployment!);
  return serviceType === ServiceType.FLIGHT
    ? toFlightView(org)
    : toHotelView(org);
}

async function readLegalRow(
  organizationId: string | Types.ObjectId,
  fields: string,
): Promise<OrganizationLegalRow> {
  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select(fields)
    .lean<OrganizationLegalRow | null>();
  if (!org) throw new NotFoundError("Organization not found");
  return org;
}

export async function getOrganizationFlightLegal(
  organizationId: string | Types.ObjectId,
): Promise<OrganizationFlightLegal> {
  return toFlightView(
    await readLegalRow(organizationId, viewFields(ServiceType.FLIGHT)),
  );
}

export async function getOrganizationHotelLegal(
  organizationId: string | Types.ObjectId,
): Promise<OrganizationHotelLegal> {
  return toHotelView(
    await readLegalRow(organizationId, viewFields(ServiceType.HOTEL)),
  );
}

export async function getOrganizationCarLegal(
  organizationId: string | Types.ObjectId,
): Promise<OrganizationCarLegal> {
  const [org, deployment] = await Promise.all([
    readLegalRow(organizationId, viewFields(ServiceType.CAR_RENTAL)),
    deploymentCarLegal(),
  ]);
  return toCarView(org, deployment);
}

/**
 * The named service's text, for a service the organization SELLS — the
 * legal route's read. A service it does not sell is refused rather than
 * shown with its built-in default: there is no configuration surface for it
 * at all, by any route.
 */
export async function getOrganizationServiceLegal(
  organizationId: string | Types.ObjectId,
  serviceType: OrganizationLegalService,
): Promise<AnyServiceLegalView> {
  const org = await readLegalRow(organizationId, viewFields(serviceType));
  if (!sells(org, serviceType)) {
    throw new ValidationError(SERVICE_COPY[serviceType].notSold(org.brandName));
  }
  const deployment =
    serviceType === ServiceType.CAR_RENTAL ? await deploymentCarLegal() : null;
  return toView(org, serviceType, deployment);
}

/**
 * The terms an admin email preview shows for one service: exactly what the
 * SELECTED organization's next order of that service would freeze — its own
 * text, else that service's default. With no organization selected: the
 * deployment car rental text, or the built-in flight/hotel text. Never
 * another service's text.
 */
export async function previewLegalFor(
  serviceType: OrganizationLegalService,
): Promise<DeploymentCarLegal> {
  const organization = await getSelectedOrganization();
  const pick = (paired: PairedServiceLegal): DeploymentCarLegal => ({
    termsAndConditions: paired.termsAndConditions,
    termsVersion: paired.termsVersion,
    cancellationPolicy: paired.cancellationPolicy,
    cancellationPolicyVersion: paired.cancellationPolicyVersion,
  });
  if (serviceType === ServiceType.CAR_RENTAL) {
    const deployment = await deploymentCarLegal();
    if (!organization) return deployment;
    const org = await readLegalRow(organization.id, viewFields(serviceType));
    return pick(pairCarLegal(org.legal, deployment));
  }
  if (!organization) return pick(pairServiceLegal(serviceType, null));
  const org = await readLegalRow(organization.id, viewFields(serviceType));
  return pick(pairServiceLegal(serviceType, org.legal?.services?.[serviceType]));
}

/**
 * Save the SELECTED organization's own terms and cancellation policy for one
 * service (CAR_RENTAL, FLIGHT or HOTEL).
 *
 * The organization comes only from the request's organization scope — the
 * selected-org cookie, validated against the caller's memberships — so an
 * admin can only ever change the brand they are working in, and only for a
 * service that brand sells. Orders already created keep the text and
 * version they froze.
 */
export async function updateOrganizationServiceLegal(
  input: UpdateServiceLegalInput,
  ctx: UpdateOrganizationLegalContext,
): Promise<AnyServiceLegalView> {
  const serviceType = input.serviceType;
  const copy = SERVICE_COPY[serviceType];
  const isCar = serviceType === ServiceType.CAR_RENTAL;
  const organizationId = organizationStamp(await getRequestOrganizationScope());
  if (!organizationId) {
    throw new ForbiddenError("Select an organization to continue");
  }

  const org = await readLegalRow(organizationId, viewFields(serviceType));

  if (!sells(org, serviceType)) {
    throw new ValidationError(copy.notSold(org.brandName));
  }
  const deployment = isCar ? await deploymentCarLegal() : null;
  const current = toServiceView(org, serviceType, deployment);

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
    throw new ConflictError(copy.staleEdit);
  }

  // Diffed against the text new orders of this service freeze today — the
  // organization's own, or the default it is still on. A field saved
  // untouched therefore stays on the default and keeps its version; only a
  // text that really changed is written, re-versioned and audited.
  const stored: StoredServiceLegal | null = isCar
    ? (org.legal ?? null)
    : (org.legal?.services?.[serviceType] ?? null);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const next: Partial<OrganizationServiceLegal> = {};

  // Versions bump from the STORED label — the same rule as the deployment
  // settings — and from the version in force when there is none: "v1" for a
  // built-in default (so a first text of its own is "v2"), the deployment
  // default's for car rental (so the version a customer sees never goes
  // backwards).
  if (!isEqual(current.termsAndConditions, input.termsAndConditions)) {
    const bumped = nextPolicyVersion(
      stored?.termsVersion?.trim() || current.termsVersion,
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
      stored?.cancellationPolicyVersion?.trim() ||
        current.cancellationPolicyVersion,
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

  const set: Record<string, unknown> = {
    updatedBy: new Types.ObjectId(ctx.actorId),
  };
  if (isCar) {
    // Car rental's own text is the organization's top-level legal: plain
    // string fields, written in place. The deployment default is never
    // touched, so no other brand's car rental orders change.
    for (const [field, value] of Object.entries(next)) {
      set[`legal.${field}`] = value;
    }
  } else if (stored) {
    for (const [field, value] of Object.entries(next)) {
      set[`legal.services.${serviceType}.${field}`] = value;
    }
  } else {
    // `$set` creates missing parents but cannot write THROUGH a stored
    // null, and Mongoose stores `legal.services` and each of its slots as
    // null by default on a new document. So `legal.services` is first made
    // an object — only while it is still null, so a first save of the OTHER
    // service racing this one is never replaced — and then this service's
    // whole block is written, with an untouched text left empty (still on
    // the built-in default). Nothing outside this one slot is ever written.
    if (!org.legal?.services) {
      await Organization.updateOne(
        { _id: organizationId, "legal.services": null },
        { $set: { "legal.services": {} } },
      );
    }
    const block: OrganizationServiceLegal = {
      termsAndConditions: "",
      termsVersion: "",
      cancellationPolicy: "",
      cancellationPolicyVersion: "",
      ...next,
    };
    set[`legal.services.${serviceType}`] = block;
  }

  const updated = await Organization.findByIdAndUpdate(
    organizationId,
    { $set: set },
    { returnDocument: "after" },
  )
    .select(viewFields(serviceType))
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
    metadata: { serviceType, changes },
    // Explicit rather than ambient: the row belongs to the brand whose
    // terms changed.
    organizationId,
  });

  return toView(updated, serviceType, deployment);
}

/** The flight save: `updateOrganizationServiceLegal` for FLIGHT. */
export async function updateOrganizationFlightLegal(
  input: Omit<UpdateServiceLegalInput, "serviceType"> & {
    serviceType?: typeof ServiceType.FLIGHT;
  },
  ctx: UpdateOrganizationLegalContext,
): Promise<OrganizationFlightLegal> {
  return (await updateOrganizationServiceLegal(
    { ...input, serviceType: ServiceType.FLIGHT },
    ctx,
  )) as OrganizationFlightLegal;
}
