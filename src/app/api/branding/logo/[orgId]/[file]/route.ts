import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import { Branding, BRANDING_KEY } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public per-org logo handler. The bytes live on the Branding doc so
 * uploaded logos survive deploys and are shared across app instances -
 * the alternative (writing to `public/branding/`) only works in dev
 * because DigitalOcean App Platform's filesystem is ephemeral.
 *
 * URL shape: `/api/branding/logo/{orgId}/{hash}.{ext}`.
 *  - `orgId` is the tenant lookup. Legacy single-tenant rows live under
 *    the literal segment `default` (matching `BRANDING_KEY`).
 *  - `{hash}.{ext}` is purely a cache-buster, the route ignores both
 *    segments and serves the current `logoBytes` for the org. Updates
 *    bump the hash in `Branding.logo`, which forces clients + email
 *    pipelines to refetch.
 *
 * No auth: customer surfaces (transactional emails, /pay landing
 * pages) need to hot-link this. The orgId is treated like an opaque
 * identifier, the URL is shared with the customer, so possession of
 * the URL is the access grant.
 */
interface RouteParams {
  params: Promise<{ orgId: string; file: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  await connectMongo();

  const filter =
    orgId === BRANDING_KEY || !Types.ObjectId.isValid(orgId)
      ? { key: BRANDING_KEY }
      : { orgId: new Types.ObjectId(orgId) };

  const doc = await Branding.findOne(filter)
    .select("+logoBytes logoMimeType")
    .lean<{ logoBytes?: Buffer | null; logoMimeType?: string | null }>();

  if (!doc?.logoBytes || !doc.logoMimeType) {
    return new Response("Not found", { status: 404 });
  }

  // Aggressive caching is safe because new uploads change the URL hash
  // segment, so customer clients pulling the new email / page get a
  // fresh URL. Old URLs continue resolving to the current bytes too -
  // logo updates are visual identity, not security-sensitive.
  // Copy into a fresh Uint8Array over a plain ArrayBuffer so the body
  // type lines up with BodyInit, Buffer's ArrayBufferLike (which can
  // be SharedArrayBuffer) is not assignable to it under strict TS.
  const owned = new Uint8Array(doc.logoBytes.byteLength);
  owned.set(doc.logoBytes);
  const blob = new Blob([owned], { type: doc.logoMimeType });
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": doc.logoMimeType,
      "Content-Length": String(doc.logoBytes.byteLength),
      "Cache-Control": "public, max-age=2592000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
