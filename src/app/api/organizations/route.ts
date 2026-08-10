import { jsonOk, withApi } from "@/server/api/respond";
import {
  getSelectedOrganization,
  listMemberOrganizations,
} from "@/server/auth/organization";
import { requireUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/organizations — the organizations the caller may act in, plus
 * which one is currently selected.
 *
 * Scoped to the caller's own memberships; there is no "list all
 * organizations" surface, because a user has no legitimate reason to learn
 * that other tenants exist.
 */
export const GET = withApi(async () => {
  await requireUser();
  const [organizations, selected] = await Promise.all([
    listMemberOrganizations(),
    getSelectedOrganization(),
  ]);
  return jsonOk({ organizations, selectedId: selected?.id ?? null });
});
