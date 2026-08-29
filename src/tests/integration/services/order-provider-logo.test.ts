import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { UserRole } from "@/lib/constants/enums";
import { Order, Provider } from "@/server/db/models";
import {
  getOrderById,
  listOrders,
  createOrder,
} from "@/server/services/order.service";
import {
  createProvider,
  invalidateProviderLogoCache,
  replaceProviderLogo,
} from "@/server/services/provider.service";
import { isAssetUrl } from "@/server/storage/asset-store";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Provider logos on ORDERS.
 *
 * THE BUG: an order freezes a provider SNAPSHOT at creation. That is right
 * for brand identity, but the snapshot also froze the logo URL — a pointer
 * to mutable storage. Every logo uploaded before the GridFS migration lived
 * at `/providers/<key>-<hex>.<ext>` and was destroyed by a later deploy, so
 * in production 19 AVIS orders and 3 SIXT orders rendered a broken image
 * while the Providers page, which reads the live document, rendered fine.
 *
 * Why it hit only SOME providers: `resolveProvider` already ignores the
 * snapshot's logo when the id is in the hardcoded PROVIDER_SEED (BUDGET,
 * THRIFTY, HERTZ, DOLLAR, ENTERPRISE, ALAMO) and uses the registry path
 * instead — which is why those six never broke. Only admin-created
 * providers fell through to the frozen snapshot value.
 *
 * THE FIX: `orderToDTO` resolves the logo LIVE and falls back to the
 * snapshot. Name and colours stay frozen, because those are the evidence.
 */

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const actor = actorFor(UserRole.ADMIN);

/** A dead pre-migration logo path, exactly as production stored it. */
const DEAD_PATH = "/providers/avis-563c9c0b.jpg";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function providerInput(over: Record<string, unknown> = {}) {
  return {
    key: "AVIS",
    name: "AVIS",
    logo: DEAD_PATH,
    primaryColor: "#1E3A8A",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    sortOrder: 0,
    ...over,
  } as Parameters<typeof createProvider>[0];
}

/** Write an order straight through the driver with a chosen provider
 *  snapshot — reproducing a historical row rather than simulating one. */
async function legacyOrderWithSnapshot(snapshot: {
  id: string;
  name: string;
  logo: string;
}) {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.collection.updateOne(
    { _id: new Types.ObjectId(order.id) },
    {
      $set: {
        "provider.id": snapshot.id,
        "provider.name": snapshot.name,
        "provider.logo": snapshot.logo,
      },
    },
  );
  return order.id;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  invalidateProviderLogoCache();
  sessionMock = await mockSession(actor);
  setNextHeaders({});
});

describe("A. existing order with a dead provider image URL", () => {
  it("renders the provider's CURRENT logo instead of the dead snapshot", async () => {
    const provider = await createProvider(providerInput(), ctxOf());
    const withLive = await replaceProviderLogo(
      provider.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    expect(isAssetUrl(withLive.logo)).toBe(true);

    // An order created BEFORE the migration, frozen at the dead path.
    const orderId = await legacyOrderWithSnapshot({
      id: "AVIS",
      name: "AVIS",
      logo: DEAD_PATH,
    });

    // Confirm the stored snapshot really is the dead value — otherwise this
    // test would pass for the wrong reason.
    const raw = await Order.collection.findOne({
      _id: new Types.ObjectId(orderId),
    });
    expect(raw!.provider.logo).toBe(DEAD_PATH);

    const dto = await getOrderById(orderId, { actor });
    expect(dto.provider.logo).toBe(withLive.logo);
    expect(dto.provider.logo).not.toBe(DEAD_PATH);
  });

  it("keeps the snapshot's NAME, which is dispute evidence", async () => {
    const provider = await createProvider(providerInput(), ctxOf());
    await replaceProviderLogo(
      provider.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    // The catalog entry was renamed after the order was placed.
    await Provider.updateOne(
      { key: "AVIS" },
      { $set: { name: "Avis Budget Group" } },
    );
    invalidateProviderLogoCache();

    const orderId = await legacyOrderWithSnapshot({
      id: "AVIS",
      name: "AVIS",
      logo: DEAD_PATH,
    });
    const dto = await getOrderById(orderId, { actor });

    // Logo resolves live; the NAME the customer saw is preserved.
    expect(dto.provider.name).toBe("AVIS");
    expect(isAssetUrl(dto.provider.logo)).toBe(true);
  });

  it("falls back to the snapshot when the provider no longer exists", async () => {
    // A deleted brand must still render what the customer saw, not a blank.
    const orderId = await legacyOrderWithSnapshot({
      id: "GONE",
      name: "Gone Rentals",
      logo: "/providers/gone-legacy.png",
    });
    const dto = await getOrderById(orderId, { actor });
    expect(dto.provider.logo).toBe("/providers/gone-legacy.png");
    expect(dto.provider.name).toBe("Gone Rentals");
  });
});

describe("B/C/D. new uploads, new orders, replacement", () => {
  it("a NEW order created after the fix carries a live asset URL", async () => {
    const provider = await createProvider(providerInput({ key: "NEWCO" }), ctxOf());
    const live = await replaceProviderLogo(
      provider.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    const orderId = await legacyOrderWithSnapshot({
      id: "NEWCO",
      name: "New Co",
      logo: live.logo,
    });
    const dto = await getOrderById(orderId, { actor });
    expect(dto.provider.logo).toBe(live.logo);
    expect(isAssetUrl(dto.provider.logo)).toBe(true);
  });

  it("replacing the logo updates EXISTING orders on the next read", async () => {
    const provider = await createProvider(providerInput({ key: "REPL" }), ctxOf());
    const first = await replaceProviderLogo(
      provider.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    const orderId = await legacyOrderWithSnapshot({
      id: "REPL",
      name: "Repl Co",
      logo: first.logo,
    });
    expect((await getOrderById(orderId, { actor })).provider.logo).toBe(
      first.logo,
    );

    const second = await replaceProviderLogo(
      provider.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    // The write invalidated the cache, so no stale value survives.
    expect((await getOrderById(orderId, { actor })).provider.logo).toBe(
      second.logo,
    );
  });
});

describe("E. multiple providers affected, and the seeded ones unaffected", () => {
  it("repairs every affected provider in one list render", async () => {
    const avis = await createProvider(providerInput({ key: "AVIS" }), ctxOf());
    const sixt = await createProvider(
      providerInput({ key: "SIXT", name: "SIXT", logo: "/providers/sixt-ace37dd4.jpg" }),
      ctxOf(),
    );
    const avisLive = await replaceProviderLogo(
      avis.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );
    const sixtLive = await replaceProviderLogo(
      sixt.id,
      { buffer: PNG_1X1, mimeType: "image/png" },
      ctxOf(),
    );

    await legacyOrderWithSnapshot({ id: "AVIS", name: "AVIS", logo: DEAD_PATH });
    await legacyOrderWithSnapshot({
      id: "SIXT",
      name: "SIXT",
      logo: "/providers/sixt-ace37dd4.jpg",
    });

    const page = await listOrders({ page: 1, pageSize: 50, state: "ACTIVE" }, { actor });
    const byId = Object.fromEntries(
      page.items.map((o) => [o.provider.id, o.provider.logo]),
    );
    expect(byId.AVIS).toBe(avisLive.logo);
    expect(byId.SIXT).toBe(sixtLive.logo);
    for (const logo of Object.values(byId)) {
      expect(String(logo)).not.toMatch(/^\/providers\/.*-[0-9a-f]{8}\./);
    }
  });

  it("a repo-backed seeded provider is untouched", async () => {
    // BUDGET is in PROVIDER_SEED and its file ships with the repo. It never
    // broke and must keep resolving to exactly the same committed path.
    const orderId = await legacyOrderWithSnapshot({
      id: "BUDGET",
      name: "Budget",
      logo: "/providers/budget.png",
    });
    const dto = await getOrderById(orderId, { actor });
    expect(dto.provider.logo).toBe("/providers/budget.png");
  });

  it("a provider with no uploaded logo keeps its placeholder", async () => {
    await createProvider(
      providerInput({ key: "NOLOGO", logo: "/providers/_placeholder.svg" }),
      ctxOf(),
    );
    const orderId = await legacyOrderWithSnapshot({
      id: "NOLOGO",
      name: "No Logo Co",
      logo: "/providers/_placeholder.svg",
    });
    const dto = await getOrderById(orderId, { actor });
    expect(dto.provider.logo).toBe("/providers/_placeholder.svg");
  });
});

function ctxOf() {
  return { actor };
}
