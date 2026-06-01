import "server-only";

import { Types } from "mongoose";

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import type { UserRole } from "@/lib/constants/enums";
import type { RequestContext } from "@/server/api/request-context";

/**
 * Per-request tenant + actor envelope. Every service that touches
 * org-owned data should take an `OrgContext` (not a bare actor) so the
 * `orgId` flows through to every repository call.
 *
 * Phase 0 introduces the type and the constructor helpers; existing
 * services keep their current signatures. New code (and refactors of
 * touched code) should adopt this shape.
 */
export interface OrgContext {
  /** Hex string of the active organization id. Always present. */
  orgId: string;
  actor: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
  };
  request: RequestContext | null;
}

/**
 * Build an `OrgContext` from already-validated parts. Throws if the
 * orgId is not a valid ObjectId, guards against a stale JWT carrying
 * a random string into a Mongo query.
 */
export function buildOrgContext(input: {
  orgId: string | null | undefined;
  actor: OrgContext["actor"];
  request: RequestContext | null;
}): OrgContext {
  if (!input.orgId) {
    throw new UnauthorizedError(
      "Session has no organization context, please sign in again",
    );
  }
  if (!Types.ObjectId.isValid(input.orgId)) {
    throw new UnauthorizedError("Invalid organization context");
  }
  return {
    orgId: input.orgId,
    actor: input.actor,
    request: input.request,
  };
}

/**
 * Guardrail: throw if a caller forgot to pass an orgId into a place
 * that should be tenant-scoped. Centralised so the error message + code
 * path are consistent.
 */
export function requireOrgId(orgId: string | null | undefined): string {
  if (!orgId) {
    throw new ForbiddenError("Operation requires an organization scope");
  }
  if (!Types.ObjectId.isValid(orgId)) {
    throw new ForbiddenError("Invalid organization id");
  }
  return orgId;
}

/**
 * Convenience: convert the orgId hex string into an ObjectId for Mongo
 * filters. Hoisted here so call-sites don't sprinkle `new Types.ObjectId`
 * in service files (and so swapping to bson/Buffer later is one place).
 */
export function orgIdFilter(orgId: string): Types.ObjectId {
  return new Types.ObjectId(orgId);
}
