import { notFound } from "next/navigation";

import { EvidenceChainView } from "@/components/features/evidence/evidence-chain-view";
import {
  Permission,
  roleHasPermission,
} from "@/lib/constants/permissions";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/session";
import { getEvidenceChain } from "@/server/services/evidence.service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order evidence" };

interface EvidencePageProps {
  params: Promise<{ id: string }>;
}

/**
 * Server-rendered evidence page. The whole point of dispute defense is
 * that the page is rendered fresh against the database at view time —
 * no client-side caches, no stale data, no derived state. The verify
 * step recomputes every hash so the integrity badge reflects the
 * current state of the chain in mongo.
 *
 * RBAC: EVIDENCE_VIEW (admin + super admin). Staff get a 404 — we
 * don't reveal which orders exist as evidence-tracked.
 */
export default async function OrderEvidencePage({
  params,
}: EvidencePageProps) {
  const user = await requirePermission(Permission.EVIDENCE_VIEW);
  const { id } = await params;
  const chain = await loadChainOrNotFound(id, user);
  const canExport = roleHasPermission(user.role, Permission.EVIDENCE_EXPORT);
  return <EvidenceChainView chain={chain} canExport={canExport} />;
}

async function loadChainOrNotFound(
  id: string,
  user: {
    id: string;
    name: string;
    email: string;
    role: import("@/lib/constants/enums").UserRole;
    orgId: string | null;
  },
) {
  try {
    return await getEvidenceChain(id, { actor: user, orgId: user.orgId });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
}
