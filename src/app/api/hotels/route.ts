import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { createHotelSchema, listHotelsQuerySchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { createHotel, listHotels } from "@/server/services/hotel.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hotel catalog. Mirrors /api/car-links — the same shape, the same
 * staff-can-browse-and-add / admin-can-manage split.
 *
 * Deliberately NOT organization-scoped: the catalog is shared reference
 * data (see hotel.service.ts). Tenancy lives on the order that references
 * a hotel, not on the catalog row.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.HOTEL_VIEW);
  const url = new URL(req.url);
  const query = listHotelsQuerySchema.parse(
    Object.fromEntries(url.searchParams.entries()),
  );
  // Only admins may ask for archived rows.
  if (query.includeArchived && actor.role === "STAFF") {
    query.includeArchived = false;
  }
  const items = await listHotels(query);
  return jsonOk({ items });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.HOTEL_CREATE);
  const body = await req.json();
  const input = createHotelSchema.parse(body);
  const ctx = await getRequestContext();
  const hotel = await createHotel(input, { actor, request: ctx });
  return jsonOk(hotel, { status: 201 });
});
