import { loadEnvFile } from "./load-env";

loadEnvFile(".env.test");

import "@testing-library/jest-dom/vitest";

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Unit-test environment setup.
 *
 *   - Loads .env.test so any module that reads `process.env` at import
 *     time (env.ts, jwt.ts) finds a valid value.
 *   - Wires React Testing Library's automatic cleanup so DOM state never
 *     leaks between tests.
 *   - Provides safe, side-effect-free defaults for browser APIs jsdom
 *     doesn't ship (matchMedia, ResizeObserver, IntersectionObserver) so
 *     components that read them at mount time don't crash.
 *
 * Network calls are intentionally NOT mocked here, unit tests should
 * never make them. If a test triggers one it's a sign the test belongs in
 * the integration project instead.
 */

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  class StubObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }

  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: typeof StubObserver }).ResizeObserver =
      StubObserver;
  }

  if (!("IntersectionObserver" in window)) {
    (window as unknown as {
      IntersectionObserver: typeof StubObserver;
    }).IntersectionObserver = StubObserver;
  }

  if (!("scrollTo" in window)) {
    (window as unknown as { scrollTo: () => void }).scrollTo = () => {};
  }
}

/**
 * Global fetch fence, fail loud if a unit test slips a real network call.
 * Tests that need fetch should mock it explicitly with vi.stubGlobal.
 */
vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error(
      "[unit] fetch() is forbidden in unit tests, mock it with vi.stubGlobal('fetch', ...) or move the test to the integration project.",
    );
  }),
);
