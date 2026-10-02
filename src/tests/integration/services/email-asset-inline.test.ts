import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureMongo } from "@/tests/utils/db";

/**
 * INLINING AN OPERATOR-UPLOADED LOGO INTO AN EMAIL.
 *
 * Two kinds of logo value reach the inliner and they live in different
 * places:
 *
 *   "/providers/budget.png"  a file committed under public/
 *   "/api/assets/<id>"       bytes in the GridFS asset bucket, served by a
 *                            dynamic route — NOT a file, and never has been
 *
 * Production was reading the second as if it were the first, asking the
 * filesystem for `public/api/assets/<id>` and logging
 * `email.image_inline_failed ... ENOENT`. These pin both paths, and pin that
 * a missing asset degrades to "no inline image" rather than to a filesystem
 * read that cannot succeed.
 */

const { inlinePublicImage, _clearInlineImageCache } = await import(
  "@/server/email/inline-image"
);
const { putAsset, assetUrl } = await import("@/server/storage/asset-store");

// Smallest valid PNG: 1x1, transparent.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAX+XsZQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(async () => {
  await ensureMongo();
  _clearInlineImageCache();
});

describe("an operator-uploaded asset", () => {
  it("inlines from the asset store, not the filesystem", async () => {
    const stored = await putAsset({
      buffer: PNG_1X1,
      contentType: "image/png",
      kind: "provider-logo",
      label: "test-provider",
    });

    const uri = await inlinePublicImage(assetUrl(stored.id));
    expect(uri).toBeTruthy();
    expect(uri!.startsWith("data:image/png;base64,")).toBe(true);
    // The bytes that come back are the bytes that went in.
    expect(uri).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
  });

  it("inlines it from an absolute URL on our own host too", async () => {
    const stored = await putAsset({
      buffer: PNG_1X1,
      contentType: "image/png",
      kind: "provider-logo",
    });
    const uri = await inlinePublicImage(
      `http://localhost:3000${assetUrl(stored.id)}`,
    );
    expect(uri!.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("reads the bucket once per asset, then serves from cache", async () => {
    const stored = await putAsset({
      buffer: PNG_1X1,
      contentType: "image/png",
      kind: "provider-logo",
    });
    const first = await inlinePublicImage(assetUrl(stored.id));
    const second = await inlinePublicImage(assetUrl(stored.id));
    expect(second).toBe(first);
  });
});

describe("an asset that is not there", () => {
  it("returns null instead of attempting a public/ file read", async () => {
    // A well-formed id that the bucket does not hold. The old code turned
    // this into `open public/api/assets/<id>` and an ENOENT warning; there
    // is no file to find because this URL was never a file.
    const warn = vi.spyOn(
      await import("@/lib/logger").then((m) => m.logger),
      "warn",
    );
    const uri = await inlinePublicImage("/api/assets/000000000000000000000000");
    expect(uri).toBeNull();

    const paths = warn.mock.calls
      .map((c) => JSON.stringify(c[1] ?? {}))
      .join(" ");
    expect(paths).not.toContain("public/api/assets");
    expect(paths).not.toContain("ENOENT");
    warn.mockRestore();
  });

  it("returns null for a malformed asset id without touching the disk", async () => {
    const warn = vi.spyOn(
      await import("@/lib/logger").then((m) => m.logger),
      "warn",
    );
    expect(await inlinePublicImage("/api/assets/not-an-object-id")).toBeNull();
    // Must not have degenerated into a public/ file read.
    const logged = warn.mock.calls
      .map((c) => `${String(c[0])} ${JSON.stringify(c[1] ?? {})}`)
      .join(" ");
    expect(logged).not.toContain("public/api/assets");
    expect(logged).not.toContain("ENOENT");
    warn.mockRestore();
  });
});

describe("the committed public/ logos still work", () => {
  it("inlines a file-backed provider logo exactly as before", async () => {
    const uri = await inlinePublicImage("/providers/budget.png");
    expect(uri).toBeTruthy();
    expect(uri!.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("passes a data: URI straight through", async () => {
    const d = "data:image/png;base64,AAAA";
    expect(await inlinePublicImage(d)).toBe(d);
  });

  it("refuses to proxy-fetch a remote host", async () => {
    expect(await inlinePublicImage("https://example.com/x.png")).toBeNull();
  });

  it("still blocks path traversal out of public/", async () => {
    expect(await inlinePublicImage("/../../etc/passwd")).toBeNull();
  });
});
