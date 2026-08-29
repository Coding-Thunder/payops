import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { ServiceType, UserRole } from "@/lib/constants/enums";
import { Provider } from "@/server/db/models";
import {
  createProvider,
  listActiveProviders,
  replaceProviderLogo,
  updateProvider,
} from "@/server/services/provider.service";
import {
  assetIdFromUrl,
  getAsset,
  isAssetUrl,
} from "@/server/storage/asset-store";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Provider logo storage — the regression guard for a bug that reached
 * production and stayed there.
 *
 * THE BUG: `saveProviderLogoFile` wrote uploaded bytes into
 * `public/providers/` with `fs.writeFile` and stored the resulting
 * `/providers/<key>-<hex>.<ext>` path on the document. That path can never
 * resolve on this deployment — Next serves `public/` out of the BUILD
 * ARTIFACT, and DigitalOcean rebuilds the container on every deploy — so
 * the record was correct while the bytes were simply absent.
 *
 * Confirmed against production before the fix: every repo-committed logo
 * (`budget.png`, `hertz.png`) returned 200, while both runtime-uploaded
 * ones (`avis-563c9c0b.jpg`, `sixt-ace37dd4.jpg`) returned 404. The
 * documents were structurally identical apart from the `logo` value, which
 * is what ruled out the form, the DTO, the API and the renderer.
 *
 * These tests assert the property that was violated: after an upload, the
 * stored URL must RESOLVE TO ACTUAL BYTES. A test that only checked "the
 * document has a logo string" would have passed throughout the outage.
 */

const actor = actorFor(UserRole.ADMIN);
const ctx = { actor };

/** Smallest valid PNG: 1x1, correct magic bytes so the sniffer accepts it. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function providerInput(over: Record<string, unknown> = {}) {
  return {
    key: "LOGOTEST",
    name: "Logo Test",
    logo: "/providers/_placeholder.svg",
    primaryColor: "#1E3A8A",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    sortOrder: 0,
    ...over,
  } as Parameters<typeof createProvider>[0];
}

beforeEach(async () => {
  await ensureMongo();
});

describe("uploaded provider logos resolve to real bytes", () => {
  it("stores the image durably and the persisted URL fetches it back", async () => {
    const created = await createProvider(providerInput(), ctx);

    const updated = await replaceProviderLogo(
      created.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );

    // THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG: not "a logo path was
    // written", but "the path resolves to the bytes we uploaded".
    expect(isAssetUrl(updated.logo)).toBe(true);
    const id = assetIdFromUrl(updated.logo);
    expect(id).toBeTruthy();

    const fetched = await getAsset(id!);
    expect(fetched).not.toBeNull();
    expect(fetched!.contentType).toBe("image/png");
    expect(Buffer.compare(fetched!.buffer, PNG_1X1)).toBe(0);
  });

  it("does NOT write a filesystem path under /providers/", async () => {
    // The precise shape of the old bug: `/providers/<key>-<hex>.<ext>`.
    const created = await createProvider(providerInput({ key: "NOFSPATH" }), ctx);
    const updated = await replaceProviderLogo(
      created.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    expect(updated.logo).not.toMatch(/^\/providers\/.*-[0-9a-f]{8}\./);
  });

  it("survives a re-read from the database (the refresh case)", async () => {
    const created = await createProvider(providerInput({ key: "REFRESH" }), ctx);
    await replaceProviderLogo(
      created.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );

    // Re-read exactly as a page render would, rather than trusting the
    // value the mutation happened to return.
    const reread = await Provider.findById(created.id).lean<{ logo: string }>();
    expect(isAssetUrl(reread!.logo)).toBe(true);
    const fetched = await getAsset(assetIdFromUrl(reread!.logo)!);
    expect(fetched).not.toBeNull();
    expect(fetched!.buffer.byteLength).toBe(PNG_1X1.byteLength);
  });

  it("replacing a logo mints a new asset and reclaims the old one", async () => {
    const created = await createProvider(providerInput({ key: "REPLACE" }), ctx);
    const first = await replaceProviderLogo(
      created.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    const firstId = assetIdFromUrl(first.logo)!;

    const second = await replaceProviderLogo(
      created.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctx,
    );
    const secondId = assetIdFromUrl(second.logo)!;

    expect(secondId).not.toBe(firstId);
    // New one resolves...
    expect(await getAsset(secondId)).not.toBeNull();
    // ...and the superseded one is cleaned up rather than orphaned forever.
    expect(await getAsset(firstId)).toBeNull();
  });

  it("rejects a payload whose bytes do not match the declared type", async () => {
    // The stored-XSS guard: HTML mislabelled as PNG must never reach the
    // store, because these bytes are served back from our own origin.
    const created = await createProvider(providerInput({ key: "SNIFF" }), ctx);
    await expect(
      replaceProviderLogo(
        created.id,
        { buffer: Buffer.from("<svg onload=alert(1)>"), mimeType: "image/png" },
        ctx,
      ),
    ).rejects.toThrow(/does not match the declared image type/i);
  });

  it("leaves repo-committed seed logos untouched", async () => {
    // Legacy rows point at real files in the build artifact and must keep
    // doing so — the fix applies to NEW uploads, not a rewrite of history.
    const created = await createProvider(
      providerInput({ key: "SEEDED", logo: "/providers/budget.png" }),
      ctx,
    );
    expect(created.logo).toBe("/providers/budget.png");
    expect(isAssetUrl(created.logo)).toBe(false);
  });
});

describe("provider visibility: shared by default", () => {
  it("a provider created with no restriction is visible to EVERY organization", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    await createProvider(
      providerInput({
        key: "GLOBALAIR",
        serviceTypes: [ServiceType.FLIGHT],
        // omitted organizationIds => global
      }),
      ctx,
    );

    for (const org of [orgA, orgB]) {
      const visible = await listActiveProviders({
        serviceType: ServiceType.FLIGHT,
        organizationId: String(org),
      });
      expect(visible.map((p) => p.key)).toContain("GLOBALAIR");
    }
  });

  it("a provider created FROM one organization does not become that org's private property", async () => {
    // The exact regression the brief calls out: adding a supplier while
    // working in GlobeVista must not make it GlobeVista-only.
    const globevista = new Types.ObjectId();
    const rental = new Types.ObjectId();
    const created = await createProvider(
      providerInput({ key: "ADDEDFROMGV", serviceTypes: [ServiceType.HOTEL] }),
      ctx,
    );
    expect(created.organizationIds).toEqual([]);

    const seenByRental = await listActiveProviders({
      serviceType: ServiceType.HOTEL,
      organizationId: String(rental),
    });
    expect(seenByRental.map((p) => p.key)).toContain("ADDEDFROMGV");
    const seenByGv = await listActiveProviders({
      serviceType: ServiceType.HOTEL,
      organizationId: String(globevista),
    });
    expect(seenByGv.map((p) => p.key)).toContain("ADDEDFROMGV");
  });

  it("an explicit restriction still confines a provider to those organizations", async () => {
    const only = new Types.ObjectId();
    const other = new Types.ObjectId();
    await createProvider(
      providerInput({
        key: "RESTRICTED",
        serviceTypes: [ServiceType.HOTEL],
        organizationIds: [String(only)],
      }),
      ctx,
    );

    expect(
      (
        await listActiveProviders({
          serviceType: ServiceType.HOTEL,
          organizationId: String(only),
        })
      ).map((p) => p.key),
    ).toContain("RESTRICTED");
    expect(
      (
        await listActiveProviders({
          serviceType: ServiceType.HOTEL,
          organizationId: String(other),
        })
      ).map((p) => p.key),
    ).not.toContain("RESTRICTED");
  });

  it("service type, not organization, is what keeps an airline out of car rental", async () => {
    const anyOrg = new Types.ObjectId();
    await createProvider(
      providerInput({ key: "AIRLINEX", serviceTypes: [ServiceType.FLIGHT] }),
      ctx,
    );
    const rentals = await listActiveProviders({
      serviceType: ServiceType.CAR_RENTAL,
      organizationId: String(anyOrg),
    });
    // Global, yet still absent from car rental.
    expect(rentals.map((p) => p.key)).not.toContain("AIRLINEX");
  });

  it("a restriction can be lifted back to global via updateProvider", async () => {
    const only = new Types.ObjectId();
    const other = new Types.ObjectId();
    const created = await createProvider(
      providerInput({
        key: "UNRESTRICT",
        serviceTypes: [ServiceType.FLIGHT],
        organizationIds: [String(only)],
      }),
      ctx,
    );
    const updated = await updateProvider(created.id, { organizationIds: [] }, ctx);
    expect(updated.organizationIds).toEqual([]);

    expect(
      (
        await listActiveProviders({
          serviceType: ServiceType.FLIGHT,
          organizationId: String(other),
        })
      ).map((p) => p.key),
    ).toContain("UNRESTRICT");
  });
});
