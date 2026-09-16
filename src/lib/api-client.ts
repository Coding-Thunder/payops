/**
 * Tiny typed fetch wrapper for the browser. Surfaces server error envelopes
 * as thrown `ApiClientError` instances - never inspect raw fetch responses
 * outside this module.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || "Request failed");
    this.name = "ApiClientError";
    this.status = status;
    this.code = body.code || "INTERNAL_ERROR";
    this.details = body.details;
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(headers as Record<string, string> | undefined),
    },
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(path, init);

  // `fetch` follows redirects on its own. An API call only lands on the
  // login page when the session has ended, and without this check that page
  // came back as a successful response to whatever the operator submitted.
  if (res.redirected && isLoginUrl(res.url)) {
    throw new ApiClientError(401, {
      code: "UNAUTHORIZED",
      message: "Your session has ended. Sign in again to continue.",
    });
  }

  const text = await res.text();
  let parsed: unknown = null;
  let malformed = false;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
      malformed = true;
    }
  }

  if (!res.ok) {
    const errBody =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      (parsed as { error: ApiErrorBody }).error
        ? (parsed as { error: ApiErrorBody }).error
        : { code: "INTERNAL_ERROR", message: res.statusText || "Request failed" };
    throw new ApiClientError(res.status, errBody);
  }

  // A success the client cannot read is not a success it can report: the
  // caller would otherwise show "saved" for a response it never understood.
  if (malformed) {
    throw new ApiClientError(res.status, {
      code: "BAD_RESPONSE",
      message:
        "The server sent a response that could not be read. Reload the page to check whether your change was saved.",
    });
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "data" in parsed &&
    "ok" in parsed
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

function isLoginUrl(url: string): boolean {
  try {
    return new URL(url).pathname === "/login";
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) =>
    apiRequest<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    apiRequest<T>(path, { ...opts, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    apiRequest<T>(path, { ...opts, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    apiRequest<T>(path, { ...opts, method: "PUT", body }),
  del: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    apiRequest<T>(path, { ...opts, method: "DELETE", body }),
};
