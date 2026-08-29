import { type NextRequest } from "next/server";

import { getAsset } from "@/server/storage/asset-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Serve an operator-uploaded asset (provider logo, branding mark) from the
 * durable store.
 *
 * PUBLIC ON PURPOSE, and safe to be: these are brand logos that already
 * appear on unauthenticated customer surfaces — the payment page, the
 * consent page, and every receipt email. Gating them behind a session would
 * break exactly the places they are needed most. The id is a random
 * ObjectId, and enumerating one yields a logo, which is not a secret.
 *
 * Deliberately NOT wrapped in `withApi`: that helper emits the JSON envelope
 * every other route returns, and this one answers with image bytes.
 *
 * The headers matter more than usual here, because this endpoint serves
 * bytes that an operator uploaded and hands them back from our own origin:
 *
 *   nosniff              stops a browser from re-interpreting an image as
 *                        HTML/script regardless of what the bytes look like
 *   Content-Disposition  inline, with no filename echoed back from user
 *                        input — a header-injection and download-name spoof
 *                        surface we simply do not open
 *   CSP sandbox          belt-and-braces: even if something reached here
 *                        with active content, it is scripted into a null
 *                        origin and can touch nothing
 *
 * `getAsset` additionally refuses to return any content type outside the
 * image allowlist, so SVG can never be served from this path.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const asset = await getAsset(id);

  if (!asset) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(new Uint8Array(asset.buffer), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.buffer.byteLength),
      // Assets are immutable — a replacement upload mints a NEW id and the
      // owning document is repointed — so this can be cached hard and for a
      // long time without a staleness problem.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
