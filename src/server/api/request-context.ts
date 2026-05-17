import { headers } from "next/headers";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export async function getRequestContext(): Promise<RequestContext> {
  const h = await headers();
  return {
    ip:
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null,
    userAgent: h.get("user-agent") || null,
    requestId: h.get("x-request-id") || null,
  };
}
