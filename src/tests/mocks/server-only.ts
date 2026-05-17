/**
 * No-op replacement for the `server-only` package in test environments.
 *
 * `server-only` exists to throw a build error if a server-only module is
 * accidentally imported from a client bundle. In Vitest we deliberately
 * import server modules from the Node test runner — so the marker must be
 * inert. Wired up via the `resolve.alias` entry in `vitest.config.ts`.
 */
export {};
