import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateHotelSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deactivateHotel,
  getHotelById,
  restoreHotel,
  updateHotel,
} from "@/server/services/hotel.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.HOTEL_VIEW);
  const { id } = await params;
  return jsonOk(await getHotelById(id));
});

export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.HOTEL_MANAGE);
  const { id } = await params;
  const body = await req.json();
  const ctx = await getRequestContext();

  // `active` is a lifecycle transition, not an ordinary field edit, so it
  // routes to the soft-delete/restore paths rather than through the field
  // whitelist — same split the car library uses.
  if (typeof body?.active === "boolean") {
    const hotel = body.active
      ? await restoreHotel(id, { actor, request: ctx })
      : await deactivateHotel(id, { actor, request: ctx });
    return jsonOk(hotel);
  }

  const input = updateHotelSchema.parse(body);
  return jsonOk(await updateHotel(id, input, { actor, request: ctx }));
});
