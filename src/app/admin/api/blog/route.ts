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
  createBlogPost,
} from "@/console/server/services/blog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a blog post. Admin-auth required.
 *
 * The body carries CONTENT ONLY. `status`, `publishedAt`, `everPublished`,
 * `updatedByEmail` and the post id are never read from it — the service sets
 * every one of them, and the actor comes from the admin session rather than
 * the payload. A new post is always a DRAFT; publishing is a separate,
 * separately audited endpoint.
 */
export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "UNAUTHORIZED", "Not signed in");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "BAD_REQUEST", "Invalid JSON");
  }

  try {
    const post = await createBlogPost(
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
      actor,
      clientIp(req),
    );
    return jsonOk({ id: post.id, slug: post.slug });
  } catch (err) {
    if (err instanceof BlogValidationError) {
      return jsonError(400, "BAD_REQUEST", err.message);
    }
    return jsonError(500, "SERVER_ERROR", "Couldn't create the post");
  }
}
