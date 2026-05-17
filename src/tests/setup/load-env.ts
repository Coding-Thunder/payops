/**
 * Loads a `.env`-style file into process.env. Hand-rolled — no
 * dependency on dotenv. Skips keys that are already populated so
 * explicit CLI overrides (`MONGODB_URI=… npm test`) still win.
 *
 * NB: this module does NOT auto-load anything on import. That used to
 * be the case but it caused the Playwright global-setup to pick up
 * .env.test instead of .env.smoke just because the helper was imported.
 * Tests opt in explicitly via the unit / integration setup files, and
 * Playwright global-setup loads .env.smoke itself.
 */

import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(filename: string): void {
  const file = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
