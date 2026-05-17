/**
 * Drives the shared `next/headers` mock that `integration.setup.ts`
 * installs. Tests call `setNextHeaders({ cookies, headers })` to seed
 * the request-scoped cookies and headers that route handlers will see.
 *
 * Shape:
 *   const { cookies, headers } = setNextHeaders({ cookies: { ... } });
 *   // `cookies` is the live Map — handler writes via `cookies().set()`
 *   // are reflected here so tests can assert on session cookies, etc.
 */

interface MockState {
  cookies: Map<string, string>;
  headers: Map<string, string>;
}

const globalKey = "__payopsNextHeadersMockState";

function getState(): MockState {
  const g = globalThis as { [k: string]: unknown };
  const existing = g[globalKey] as MockState | undefined;
  if (existing) return existing;
  const fresh: MockState = { cookies: new Map(), headers: new Map() };
  g[globalKey] = fresh;
  return fresh;
}

export interface MockHeadersHandle {
  cookies: Map<string, string>;
  headers: Map<string, string>;
  reset: () => void;
}

export function setNextHeaders(
  init: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
): MockHeadersHandle {
  const state = getState();
  state.cookies.clear();
  state.headers.clear();
  if (init.cookies) {
    for (const [k, v] of Object.entries(init.cookies)) {
      state.cookies.set(k, v);
    }
  }
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      state.headers.set(k.toLowerCase(), v);
    }
  }
  return {
    cookies: state.cookies,
    headers: state.headers,
    reset() {
      state.cookies.clear();
      state.headers.clear();
    },
  };
}

/**
 * Backwards-compatible async helper. Returns a handle with the
 * `{ cookieJar, headerMap, restore }` shape some early tests use.
 */
export async function mockNextHeaders(
  init: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const handle = setNextHeaders(init);
  return {
    cookieJar: handle.cookies,
    headerMap: handle.headers,
    async restore() {
      handle.reset();
    },
  };
}

/** Internal: used by the mock factory to read live state. */
export function _nextHeadersState(): MockState {
  return getState();
}
