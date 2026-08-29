import { beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { Branding, BRANDING_KEY } from "@/server/db/models";
import {
  getBranding,
  replaceBrandingLogo,
} from "@/server/services/branding.service";
import {
  assetIdFromUrl,
  getAsset,
  isAssetUrl,
} from "@/server/storage/asset-store";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Branding logo storage — the same regression guard the provider catalog
 * has, for the same bug in the sibling code path.
 *
 * THE BUG: `saveBrandingLogoFile` wrote uploaded bytes into
 * `public/branding/` with `fs.writeFile` and stored the resulting
 * `/branding/workspace-<hex>.<ext>` path. Next serves `public/` from the
 * BUILD ARTIFACT and DigitalOcean rebuilds the container on every deploy,
 * so the path could never resolve in production — exactly as proven for
 * the provider catalog, where every repo-committed logo returned 200 and
 * every runtime-uploaded one returned 404.
 *
 * This surface is arguably worse than the provider one: the branding logo
 * is the deployment's own mark, and it renders on the payment page, the
 * consent page and every receipt email. A broken image there is on the
 * screen where a customer decides whether to trust the charge.
 *
 * As with the provider tests, the assertion is that the stored URL RESOLVES
 * TO ACTUAL BYTES. Checking only that "a logo string was written" would
 * have passed throughout the outage.
 */

const actor = actorFor(UserRole.ADMIN);
const ctx = { actor };

/** Smallest valid PNG: 1x1, real magic bytes so the sniffer accepts it. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** Smallest valid GIF, for the replacement case. */
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

beforeEach(async () => {
  await ensureMongo();
});

describe("uploaded branding logos resolve to real bytes", () => {
  it("stores the mark durably and the persisted URL fetches it back", async () => {
    const updated = await replaceBrandingLogo(
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );

    expect(isAssetUrl(updated.logo)).toBe(true);
    const id = assetIdFromUrl(updated.logo);
    expect(id).toBeTruthy();

    const fetched = await getAsset(id!);
    expect(fetched).not.toBeNull();
    expect(fetched!.contentType).toBe("image/png");
    expect(Buffer.compare(fetched!.buffer, PNG_1X1)).toBe(0);
  });

  it("does NOT write a filesystem path under /branding/", async () => {
    // The precise shape of the old bug: `/branding/workspace-<hex>.<ext>`.
    const updated = await replaceBrandingLogo(
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    expect(updated.logo).not.toMatch(/^\/branding\/workspace-[0-9a-f]{8}\./);
    expect(updated.logo).not.toMatch(/^\/branding\//);
  });

  it("survives a re-read from the database (the refresh case)", async () => {
    await replaceBrandingLogo({ buffer: PNG_1X1, mimeType: "image/png" }, ctx);

    // Re-read the singleton the way a page render would, rather than
    // trusting what the mutation returned.
    const stored = await Branding.findOne({ key: BRANDING_KEY }).lean<{
      logo: string;
    }>();
    expect(isAssetUrl(stored!.logo)).toBe(true);

    const fetched = await getAsset(assetIdFromUrl(stored!.logo)!);
    expect(fetched).not.toBeNull();
    expect(fetched!.buffer.byteLength).toBe(PNG_1X1.byteLength);

    // ...and through the service the app actually calls.
    const dto = await getBranding();
    expect(dto.logo).toBe(stored!.logo);
  });

  it("replacing the logo mints a new asset and reclaims the old one", async () => {
    const first = await replaceBrandingLogo(
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    const firstId = assetIdFromUrl(first.logo)!;

    const second = await replaceBrandingLogo(
      { buffer: GIF_1X1, mimeType: "image/gif" },
      ctx,
    );
    const secondId = assetIdFromUrl(second.logo)!;

    expect(secondId).not.toBe(firstId);

    const now = await getAsset(secondId);
    expect(now).not.toBeNull();
    expect(now!.contentType).toBe("image/gif");
    expect(Buffer.compare(now!.buffer, GIF_1X1)).toBe(0);

    // Superseded asset is reclaimed rather than orphaned in the bucket.
    expect(await getAsset(firstId)).toBeNull();
  });

  it("rejects a payload whose bytes do not match the declared type", async () => {
    // Stored-XSS guard: these bytes are served back from our own origin,
    // so HTML/SVG mislabelled as PNG must never reach the store.
    await expect(
      replaceBrandingLogo(
        { buffer: Buffer.from("<svg onload=alert(1)>"), mimeType: "image/png" },
        ctx,
      ),
    ).rejects.toThrow(/does not match the declared image type/i);
  });

  it("refuses an unsupported image type outright", async () => {
    await expect(
      replaceBrandingLogo(
        { buffer: PNG_1X1, mimeType: "image/svg+xml" },
        ctx,
      ),
    ).rejects.toThrow(/unsupported image type/i);
  });

  it("leaves a legacy /branding/ value alone rather than trying to delete it", async () => {
    // A pre-migration document points at a filesystem path whose bytes are
    // already gone. Replacing it must succeed and must NOT attempt asset
    // reclamation on a value that was never an asset id.
    await Branding.findOneAndUpdate(
      { key: BRANDING_KEY },
      { $set: { logo: "/branding/workspace-deadbeef.png" } },
      { upsert: true },
    );

    const updated = await replaceBrandingLogo(
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    expect(isAssetUrl(updated.logo)).toBe(true);
    const fetched = await getAsset(assetIdFromUrl(updated.logo)!);
    expect(fetched).not.toBeNull();
  });
});
