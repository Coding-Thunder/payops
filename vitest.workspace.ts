/**
 * Vitest workspace — wires the "unit" and "integration" projects into a
 * single runner invocation. Use:
 *
 *   npm run test               # run everything
 *   npm run test:unit          # fast feedback loop
 *   npm run test:integration   # DB-backed
 *
 * Each project owns its own config so resolve aliases, setup files, and
 * environments stay scoped instead of fighting for the same top-level
 * surface.
 */
const projects = [
  "./vitest.unit.config.mts",
  "./vitest.integration.config.mts",
];
export default projects;
