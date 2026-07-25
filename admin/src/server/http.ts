import { NextResponse } from "next/server";

export function jsonOk<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data });
}

export function jsonError(
  status: number,
  message: string,
  code = "ERROR",
): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export function clientIp(req: Request): string | null {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null
  );
}
