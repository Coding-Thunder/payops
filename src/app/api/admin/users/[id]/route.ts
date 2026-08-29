import type { NextRequest } from "next/server";
import { Types } from "mongoose";

import { RecordState } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { updateUserSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { OrganizationMember } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getUserById, updateUser } from "@/server/services/user.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.USER_VIEW);
  const { id } = await params;
  const data = await getUserById(id);

  // The edit form pre-checks the organizations this user actually holds, so
  // the detail response carries them alongside the public user. ACTIVE only
  // — revoked memberships are kept as DISABLED rows for the audit trail and
  // must not read back as access.
  //
  // Read here rather than widened into `PublicUser`: the users LIST is the
  // hot path and has no use for a per-row membership lookup.
  await connectMongo();
  const memberships = await OrganizationMember.find({
    userId: new Types.ObjectId(data.id),
    status: RecordState.ACTIVE,
  })
    .select("organizationId")
    .lean<{ organizationId: Types.ObjectId }[]>();

  return jsonOk({
    ...data,
    organizationIds: memberships.map((m) => String(m.organizationId)),
  });
});

export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.USER_UPDATE);
  const { id } = await params;
  const body = await req.json();
  // `updateUserSchema` knows `organizationIds`, so parsing keeps it (only
  // UNKNOWN keys are stripped) and it reaches `updateUser`, which
  // reconciles memberships from it. Omitting the key leaves them untouched.
  const input = updateUserSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateUser(id, input, { actor, request: ctx });
  return jsonOk(data);
});
