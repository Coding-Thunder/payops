import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import {
  assertSameOrigin,
  clientIp,
  jsonError,
  jsonOk,
} from "@/console/server/http";
import {
  BlogValidationError,
  deleteBlogPost,
  publishBlogPost,
  unpublishBlogPost,
  updateBlogPost,
} from "@/console/server/services/blog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Edit / publish / unpublish / delete one post. Admin-auth required on every
 * verb.
 *
 * PUBLICATION IS AN ACTION, NOT A FIELD. `PATCH` writes content and cannot
 * change publication state no matter what the body contains; publishing goes
 * through `POST ?action=publish`. Splitting them is what makes "no update
 * body can publish a draft" a property of the routing rather than of careful
 * field filtering.
 */

type Ctx = { params: Promise<{ id: string }> };

async function authorize(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return { error: csrf };
  const actor = await getAdminEmail();
  if (!actor) {
    return { error: jsonError(401, "UNAUTHORIZED", "Not signed in") };
  }
  return { actor };
}

function fail(err: unknown) {
  if (err instanceof BlogValidationError) {
    return jsonError(400, "BAD_REQUEST", err.message);
  }
  return jsonError(500, "SERVER_ERROR", "Action failed");
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "BAD_REQUEST", "Invalid JSON");
  }

  try {
    const post = await updateBlogPost(
      id,
      {
        slug: String(body.slug ?? ""),
        title: String(body.title ?? ""),
        excerpt: body.excerpt == null ? null : String(body.excerpt),
        body: String(body.body ?? ""),
        coverImageUrl:
          body.coverImageUrl == null ? null : String(body.coverImageUrl),
        coverImageAlt:
          body.coverImageAlt == null ? null : String(body.coverImageAlt),
        authorName: body.authorName == null ? null : String(body.authorName),
        tags: body.tags,
        seoTitle: body.seoTitle == null ? null : String(body.seoTitle),
        seoDescription:
          body.seoDescription == null ? null : String(body.seoDescription),
      },
      auth.actor,
      clientIp(req),
    );
    return jsonOk({ id: post.id, slug: post.slug, status: post.status });
  } catch (err) {
    return fail(err);
  }
}

/** `?action=publish|unpublish`. No body is read; there is nothing to supply. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { id } = await params;
  const action = new URL(req.url).searchParams.get("action");

  try {
    if (action === "publish") {
      const post = await publishBlogPost(id, auth.actor, clientIp(req));
      return jsonOk({ status: post.status, publishedAt: post.publishedAt });
    }
    if (action === "unpublish") {
      const post = await unpublishBlogPost(id, auth.actor, clientIp(req));
      return jsonOk({ status: post.status });
    }
    return jsonError(400, "BAD_REQUEST", "Unknown action");
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await authorize(req);
  if (auth.error) return auth.error;
  const { id } = await params;
  try {
    await deleteBlogPost(id, auth.actor, clientIp(req));
    return jsonOk({ deleted: true });
  } catch (err) {
    return fail(err);
  }
}
