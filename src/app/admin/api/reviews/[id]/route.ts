import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import {
  assertSameOrigin,
  clientIp,
  jsonError,
  jsonOk,
} from "@/console/server/http";
import {
  approveReview,
  rejectReview,
  ReviewModerationError,
  setReviewNote,
  unapproveReview,
} from "@/console/server/services/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Moderate one review. Admin-auth required.
 *
 * `?action=approve|reject|unapprove|note`. There is deliberately no action
 * that edits a review's content: the service exposes none, so publishing
 * altered words under someone else's name is not something this endpoint can
 * be talked into doing.
 *
 * The actor is the authenticated console operator, resolved from the session.
 * It is never read from the body — an audit trail a caller can forge is not
 * an audit trail.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "UNAUTHORIZED", "Not signed in");

  const { id } = await params;
  const action = new URL(req.url).searchParams.get("action");
  const ip = clientIp(req);

  try {
    switch (action) {
      case "approve":
        return jsonOk(await approveReview(id, actor, ip));
      case "unapprove":
        return jsonOk(await unapproveReview(id, actor, ip));
      case "reject": {
        const body = await req.json().catch(() => ({}));
        const note = typeof body?.note === "string" ? body.note : null;
        return jsonOk(await rejectReview(id, actor, ip, note));
      }
      case "note": {
        const body = await req.json().catch(() => ({}));
        const note = typeof body?.note === "string" ? body.note : "";
        return jsonOk(await setReviewNote(id, note, actor, ip));
      }
      default:
        return jsonError(400, "BAD_REQUEST", "Unknown action");
    }
  } catch (err) {
    if (err instanceof ReviewModerationError) {
      return jsonError(400, "BAD_REQUEST", err.message);
    }
    return jsonError(500, "SERVER_ERROR", "Action failed");
  }
}
