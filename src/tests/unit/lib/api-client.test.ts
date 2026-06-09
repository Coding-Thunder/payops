import { describe, expect, it, vi } from "vitest";

import { ApiClientError, api, apiRequest } from "@/lib/api-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiRequest", () => {
  it("unwraps the { ok, data } envelope on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { hi: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest<{ hi: number }>("/x")).resolves.toEqual({ hi: 1 });
  });

  it("returns the raw parsed body when it has no envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ x: 2 })));
    await expect(apiRequest<{ x: number }>("/y")).resolves.toEqual({ x: 2 });
  });

  it("throws ApiClientError with the server's code + message on !ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { ok: false, error: { code: "FORBIDDEN", message: "nope" } },
          403,
        ),
      ),
    );
    await expect(apiRequest("/z")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 403,
      code: "FORBIDDEN",
      message: "nope",
    });
  });

  it("falls back to a default error when response body is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500, statusText: "Boom" })),
    );
    const err = (await apiRequest("/q").catch((e: unknown) => e)) as ApiClientError;
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
  });

  it("api.post forwards the body as JSON", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, data: { ok: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/things", { foo: 1 });

    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"foo":1}');
    expect(init.credentials).toBe("include");
  });

  it.each([
    ["get", "GET"],
    ["post", "POST"],
    ["patch", "PATCH"],
    ["del", "DELETE"],
  ] as const)("api.%s uses HTTP %s", async (method, http) => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await api[method]("/p");
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.method).toBe(http);
  });
});
