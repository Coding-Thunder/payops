/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Bootstrap shim for tsx-driven scripts:
 *   1. Loads .env.local into process.env BEFORE anything else
 *      (Next's env validation runs at module load).
 *   2. Stubs out the `server-only` package so server-side service
 *      modules can be imported by Node scripts.
 *
 * Loaded via `tsx --require ./scripts/shim-server-only.cjs`.
 */
const path = require("path");
const fs = require("fs");

// ── env loader ───────────────────────────────────────────────────────
for (const file of [".env.local", ".env.prod"]) {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/i.exec(line);
      if (!m || m[1].startsWith("#")) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2];
    }
    break;
  } catch {
    /* try next */
  }
}

// ── server-only stub ─────────────────────────────────────────────────
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
    children: [],
    paths: [],
    path: path.dirname(resolved),
  };
} catch {
  // server-only not installed — nothing to shim.
}
