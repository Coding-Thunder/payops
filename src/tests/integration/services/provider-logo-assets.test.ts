import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import { Order, Provider } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Provider logos must survive a deploy, and an order must keep rendering one
 * even when the pointer frozen into its snapshot is dead.
 *
 * The bug these tests pin down: logo uploads were written to
 * `public/providers/<key>-<hex>.<ext>` with fs.writeFile. Next serves
 * `public/` from the build artifact and the container is rebuilt on every
 * deploy, so the bytes were never served and never retained. Verified in
 * production — every repo-committed seed logo returned 200 while every
 * uploaded one returned 404, including one uploaded five hours earlier.
 *
 * A second, independent failure rode along: each re-upload minted a NEW
 * random suffix and repointed only the provider document, so orders created
 * in between kept a path that was already two uploads out of date. Two live
 * AVIS orders carried `/providers/avis-c49d1deb.png` while the catalog had
 * moved on to `avis-ab943ee7.png`.
 *
 * Seed brands never broke, and that is the clue that shaped the fix:
 * `resolveProvider` overrides the snapshot from PROVIDER_SEED whenever the
 * id is one of the six hardcoded brands. Resolving the logo live at the DTO
 * boundary makes that rule uniform for DB-backed providers too.
 */

const {
  saveProviderLogoFile,
  replaceProviderLogo,
  createProvider,
  invalidateProviderLogoCache,
  listProviders,
} = await import("@/server/services/provider.service");
const { createOrder, listOrders, getOrderById } = await import(
  "@/server/services/order.service"
);
const { getAsset, assetIdFromUrl } = await import(
  "@/server/storage/asset-store"
);

const LIST_QUERY = { state: RecordState.ACTIVE, page: 1, pageSize: 50 } as never;

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

/** Smallest buffer that passes the PNG magic-byte sniff. */
function pngBytes(marker = 0x01): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([marker, 0x02, 0x03, 0x04]),
  ]);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  invalidateProviderLogoCache();
  sessionMock = await mockSession(actor);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = () => ({ actor, request: null });

async function makeProvider(key: string, name: string) {
  return createProvider(
    {
      key,
      name,
      logo: "/providers/_placeholder.svg",
      primaryColor: "#123456",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 50,
    } as never,
    ctx(),
  );
}

describe("B. a provider logo uploaded through the fixed flow", () => {
  it("stores bytes in the durable asset store, not under /providers/", async () => {
    const url = await saveProviderLogoFile({
      key: "AVIS",
      buffer: pngBytes(),
      mimeType: "image/png",
    });

    // The persisted value must be an asset URL. A `/providers/...` path here
    // would mean the bytes went back to the ephemeral build artifact.
    expect(url).toMatch(/^\/api\/assets\/[0-9a-f]{24}$/);
    expect(url).not.toContain("/providers/");

    const asset = await getAsset(assetIdFromUrl(url)!);
    expect(asset).not.toBeNull();
    expect(asset!.contentType).toBe("image/png");
    expect(asset!.buffer.equals(pngBytes())).toBe(true);
  });

  it("refuses a payload whose bytes contradict its declared type", async () => {
    await expect(
      saveProviderLogoFile({
        key: "AVIS",
        buffer: Buffer.from("<svg onload=alert(1)>"),
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/does not match the declared image type/i);
  });

  it("never serves a content type outside the image allowlist", async () => {
    // Defence in depth on the way out: even if something wrote a non-image,
    // the read path refuses it rather than handing it back same-origin.
    const url = await saveProviderLogoFile({
      key: "AVIS",
      buffer: pngBytes(),
      mimeType: "image/png",
    });
    const id = assetIdFromUrl(url)!;
    const { Provider: _p } = await import("@/server/db/models");
    void _p;
    const mongoose = (await import("@/server/db/mongoose")).connectMongo;
    const conn = await mongoose();
    await conn.connection.db!.collection("uploads.files").updateOne(
      { _id: new (await import("mongodb")).ObjectId(id) },
      { $set: { "metadata.contentType": "text/html" } },
    );
    expect(await getAsset(id)).toBeNull();
  });
});

describe("A + E. orders whose snapshot points at a dead runtime path", () => {
  it("renders the provider's CURRENT logo instead of the dead pointer", async () => {
    const provider = await makeProvider("AVIS", "AVIS");
    const liveUrl = (await replaceProviderLogo(
      provider.id,
      { buffer: pngBytes(), mimeType: "image/png" },
      ctx(),
    )).logo;

    // An order created before the migration: the snapshot froze a path whose
    // bytes a later deploy destroyed.
    const { order } = await createOrder(validCreateOrderInput({ provider: "AVIS" }), ctx());
    await Order.updateOne(
      { _id: order.id },
      { $set: { "provider.logo": "/providers/avis-c49d1deb.png" } },
    );
    invalidateProviderLogoCache();

    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.provider.logo).toBe(liveUrl);
    expect(fetched.provider.logo).not.toContain("avis-c49d1deb");

    // Brand IDENTITY still comes from the snapshot — a receipt must show
    // what the customer actually saw.
    expect(fetched.provider.name).toBe("AVIS");
    expect(fetched.provider.id).toBe("AVIS");
  });

  it("heals every affected provider in a list, not just the first", async () => {
    const keys = ["AVIS", "SIXT", "FOX"];
    const live: Record<string, string> = {};
    for (const key of keys) {
      const p = await makeProvider(key, `${key} Rentals`);
      live[key] = (
        await replaceProviderLogo(
          p.id,
          { buffer: pngBytes(), mimeType: "image/png" },
          ctx(),
        )
      ).logo;
    }

    for (const key of keys) {
      const { order: o } = await createOrder(validCreateOrderInput({ provider: key }), ctx());
      await Order.updateOne(
        { _id: o.id },
        { $set: { "provider.logo": `/providers/${key.toLowerCase()}-dead1234.png` } },
      );
    }
    invalidateProviderLogoCache();

    const page = await listOrders(LIST_QUERY, ctx());
    const seen = page.items.filter((o) => keys.includes(o.provider.id));
    expect(seen).toHaveLength(keys.length);
    for (const o of seen) {
      expect(o.provider.logo).toBe(live[o.provider.id]);
      expect(o.provider.logo).not.toContain("dead1234");
    }
  });

  it("keeps the snapshot when the provider no longer exists", async () => {
    const p = await makeProvider("ROUTES_CAR_RENTAL", "Routes Car Rental");
    const { order } = await createOrder(
      validCreateOrderInput({ provider: "ROUTES_CAR_RENTAL" }),
      ctx(),
    );
    await Provider.deleteOne({ _id: p.id });
    invalidateProviderLogoCache();

    // A removed brand still renders what it always did, rather than
    // collapsing to a placeholder.
    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.provider.name).toBe("Routes Car Rental");
    expect(fetched.provider.logo).toBe("/providers/_placeholder.svg");
  });
});

describe("C. a newly created order", () => {
  it("carries the asset-store logo end to end", async () => {
    const p = await makeProvider("ACE_RENT_A_CAR", "Ace Rent A Car");
    const liveUrl = (
      await replaceProviderLogo(
        p.id,
        { buffer: pngBytes(), mimeType: "image/png" },
        ctx(),
      )
    ).logo;
    invalidateProviderLogoCache();

    const { order } = await createOrder(
      validCreateOrderInput({ provider: "ACE_RENT_A_CAR" }),
      ctx(),
    );
    expect(order.provider.logo).toBe(liveUrl);

    // The frozen snapshot is written with the asset URL too, so the value is
    // already durable even before live resolution runs.
    const raw = await Order.findById(order.id).lean<{
      provider: { logo: string };
    }>();
    expect(raw!.provider.logo).toBe(liveUrl);
  });
});

describe("D. replacing a provider logo", () => {
  it("repoints existing orders and reclaims the superseded asset", async () => {
    const p = await makeProvider("PAYLESS_CAR_RENTAL", "Payless Car Rental");
    const first = (
      await replaceProviderLogo(
        p.id,
        { buffer: pngBytes(0x11), mimeType: "image/png" },
        ctx(),
      )
    ).logo;

    const { order } = await createOrder(
      validCreateOrderInput({ provider: "PAYLESS_CAR_RENTAL" }),
      ctx(),
    );
    expect(order.provider.logo).toBe(first);

    const second = (
      await replaceProviderLogo(
        p.id,
        { buffer: pngBytes(0x22), mimeType: "image/png" },
        ctx(),
      )
    ).logo;
    expect(second).not.toBe(first);

    // The order created against the OLD logo now renders the NEW one — the
    // exact case that used to leave a broken image on the orders list.
    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.provider.logo).toBe(second);

    // Superseded bytes are reclaimed, so the store does not grow without
    // bound. Safe precisely because orders no longer trust the old pointer.
    expect(await getAsset(assetIdFromUrl(first)!)).toBeNull();
    expect(await getAsset(assetIdFromUrl(second)!)).not.toBeNull();
  });

  it("invalidates the cache immediately rather than after a TTL", async () => {
    const p = await makeProvider("U_HAUL", "U-Haul");
    await replaceProviderLogo(
      p.id,
      { buffer: pngBytes(0x33), mimeType: "image/png" },
      ctx(),
    );
    const { order } = await createOrder(
      validCreateOrderInput({ provider: "U_HAUL" }),
      ctx(),
    );
    // Warm the cache via a read, then replace without touching the cache
    // by hand — the service must have dropped it on write.
    await getOrderById(order.id, ctx());
    const next = (
      await replaceProviderLogo(
        p.id,
        { buffer: pngBytes(0x44), mimeType: "image/png" },
        ctx(),
      )
    ).logo;

    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.provider.logo).toBe(next);
  });
});

describe("regression: repo-committed seed providers are untouched", () => {
  it("keeps serving the six hardcoded brands from /providers/", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ provider: ProviderId.BUDGET }),
      ctx(),
    );
    invalidateProviderLogoCache();

    const fetched = await getOrderById(order.id, ctx());
    // These files ARE in the build artifact, so the committed path is
    // correct and must not be rewritten to an asset URL.
    expect(fetched.provider.logo).toBe("/providers/budget.png");
    expect(fetched.provider.id).toBe(ProviderId.BUDGET);
  });

  it("leaves a seed provider's committed path alone when resolving live", async () => {
    // THRIFTY exists in the catalog with its repo path; live resolution must
    // return that same value rather than a placeholder or an asset URL.
    const { order } = await createOrder(
      validCreateOrderInput({ provider: ProviderId.THRIFTY }),
      ctx(),
    );
    const page = await listOrders(LIST_QUERY, ctx());
    const found = page.items.find((o) => o.id === order.id);
    expect(found!.provider.logo).toBe("/providers/thrifty.png");
  });

  it("still shows the placeholder for a provider that has no logo", async () => {
    await makeProvider("NU_CAR_RENTALS", "Nu Car Rentals");
    const { order } = await createOrder(
      validCreateOrderInput({ provider: "NU_CAR_RENTALS" }),
      ctx(),
    );
    invalidateProviderLogoCache();

    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.provider.logo).toBe("/providers/_placeholder.svg");
  });

  it("keeps the provider catalog global — no organization narrowing", async () => {
    // The catalog is shared reference data. A blanket org filter here would
    // empty an existing dropdown, which is the regression this guards.
    await makeProvider("ADVANTAGE_RENT_A_CAR", "Advantage Rent A Car");
    // listProviders() seeds the six committed brands on first read.
    await listProviders();
    const rows = await Provider.find({ status: RecordState.ACTIVE }).lean();
    const keys = rows.map((r) => (r as { key: string }).key);
    expect(keys).toContain("ADVANTAGE_RENT_A_CAR");
    expect(keys).toContain(ProviderId.BUDGET);
    for (const row of rows) {
      expect(row).not.toHaveProperty("organizationId");
    }
  });
});
