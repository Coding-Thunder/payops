import { headers } from "next/headers";

import { clientIp } from "@/server/api/client-ip";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export async function getRequestContext(): Promise<RequestContext> {
  const h = await headers();
  return {
    ip: clientIp(h),
    userAgent: h.get("user-agent") || null,
    requestId: h.get("x-request-id") || null,
  };
}
