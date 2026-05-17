import { NextRequest } from "next/server";

/**
 * Helpers for calling Next.js App-Router route handlers directly from
 * Vitest. Skips the HTTP stack but keeps the real `NextRequest`/
 * `NextResponse` types so the test exercises the handler the same way
 * Next would.
 */

interface BuildRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  searchParams?: Record<string, string | number | boolean>;
  cookies?: Record<string, string>;
}

export function buildRequest(
  url: string,
  opts: BuildRequestOptions = {},
): NextRequest {
  const u = new URL(url, "http://localhost");
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      u.searchParams.set(k, String(v));
    }
  }
  const headers = new Headers(opts.headers ?? {});
  if (opts.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (opts.cookies) {
    const cookieHeader = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");
    if (cookieHeader) headers.set("cookie", cookieHeader);
  }

  const init: {
    method: string;
    headers: Headers;
    body?: string;
  } = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined && opts.method && opts.method !== "GET") {
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }

  return new NextRequest(u, init as ConstructorParameters<typeof NextRequest>[1]);
}

/** Parses a `NextResponse` JSON body in a way that's safe for tests. */
export async function jsonBody<T = unknown>(
  res: Response,
): Promise<{ status: number; body: T }> {
  const status = res.status;
  const text = await res.text();
  if (!text) return { status, body: {} as T };
  return { status, body: JSON.parse(text) as T };
}

/**
 * Common API envelope shapes — tests narrow into one of these so they can
 * assert without `as` casts everywhere.
 */
export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
export type ApiEnvelope<T> = ApiOk<T> | ApiErr;

export function expectOk<T>(env: ApiEnvelope<T>): asserts env is ApiOk<T> {
  if (!env.ok) {
    throw new Error(
      `Expected ok envelope, got error ${env.error?.code}: ${env.error?.message}`,
    );
  }
}

export function expectErr<T>(env: ApiEnvelope<T>): asserts env is ApiErr {
  if (env.ok) {
    throw new Error("Expected error envelope, got ok");
  }
}
