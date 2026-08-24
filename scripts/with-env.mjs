/* eslint-disable no-console */
/**
 * Run a command with `.env.payops.local` loaded, if it exists.
 *
 * Why this exists rather than `node --env-file=…`:
 *   Next spawns worker threads and propagates the parent's exec argv into
 *   NODE_OPTIONS for them. `--env-file` / `--env-file-if-exists` are not
 *   permitted in NODE_OPTIONS, so the workers die with
 *   ERR_WORKER_INVALID_EXEC_ARGV and the build fails. That took down a
 *   production deploy once; don't reintroduce it.
 *
 * Why not just name the file `.env.local`:
 *   This repo keeps one product's config per prefix (`.env.payops.*`,
 *   `.env.tracetxn.*`) so two products sharing a checkout can never read
 *   each other's. Next only auto-loads the literal name `.env.local`, and
 *   that is not configurable — hence a loader.
 *
 * Behaviour:
 *   - missing file is fine (production supplies env through the platform)
 *   - existing process.env always wins, so an inline override on the
 *     command line beats the file
 *   - the child's exit code and signal are propagated verbatim
 *
 * Usage: node scripts/with-env.mjs <command> [args...]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Two selectors, both optional and both defaulting to today's behaviour:
//   PAYOPS_ENV_FILE  an explicit path, wins outright
//   PAYOPS_ENV_DIR   which deployment's copy of the standard filename to use
// Unset, this resolves `.env.payops.local` at the repository root, which is
// what every existing script does.
const ENV_FILE =
  process.env.PAYOPS_ENV_FILE ??
  path.join(process.env.PAYOPS_ENV_DIR ?? "", ".env.payops.local");

/** Minimal dotenv parse — same rules as src/tests/setup/load-env.ts. */
function loadEnvFile(filename) {
  const file = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(file)) return 0;
  let loaded = 0;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // NODE_ENV is owned by the tool, never by the file. Next itself refuses
    // to read NODE_ENV out of a .env file for good reason: letting a local
    // file say `development` during `next build` produces a development
    // React in a production build, and prerendering dies with a bare
    // "Cannot read properties of null (reading 'useContext')" that gives no
    // hint where it came from.
    if (key === "NODE_ENV") continue;
    // Never clobber an explicitly-set variable: the platform (and an
    // inline `FOO=bar npm run build`) must win over the file.
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("with-env: no command given");
  process.exit(1);
}

const count = loadEnvFile(ENV_FILE);
if (count > 0) console.log(`[with-env] loaded ${count} vars from ${ENV_FILE}`);

const child = spawn(command, args, { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`with-env: failed to start ${command}:`, err.message);
  process.exit(1);
});
