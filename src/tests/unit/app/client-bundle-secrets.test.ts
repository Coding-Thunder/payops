// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Nothing secret may reach the browser bundle.
 *
 * Every `process.env.X` literal inside a `"use client"` module is INLINED by
 * Next into the JavaScript it ships to visitors. `NEXT_PUBLIC_*` is the
 * opt-in prefix that says "this is safe to publish"; anything else in a
 * client module is a secret being handed out.
 *
 * This became worth pinning when Microsoft Clarity was added: it introduced
 * the first analytics variable, and the shape of that change — a public id
 * read for a third-party script — is exactly the shape that invites someone
 * to reach for the neighbouring secret next time. `src/lib/env.ts` splits
 * `env.server` from `env.public` for the same reason, and `env.server`
 * throws in the browser; this test is the static counterpart, catching the
 * mistake at `npm test` rather than at runtime on someone's page load.
 *
 * Runs in the node environment for `node:fs`.
 */

const SRC = path.resolve(process.cwd(), "src");

/**
 * Skipped wholesale: tests are not shipped, and `src/app/api` is
 * server-only route handlers that can never carry a "use client" directive.
 */
const SKIP_DIRS = new Set(["tests", "node_modules", ".next"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments before matching. This repo documents its decisions at
 * length, so several modules DISCUSS `process.env` and `env.server` in prose
 * — including the Clarity gate, whose whole point is that it does not read
 * them. Matching raw source would fail on the documentation rather than on
 * the code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * A module is client-side if its first directive is "use client". Matching
 * the directive prologue (not just "does the file contain the string")
 * avoids counting the many doc comments in this repo that mention it.
 */
function isClientModule(code: string): boolean {
  return /^\s*["']use client["']/.test(code);
}

const CLIENT_MODULES = walk(SRC)
  .map((file) => {
    const source = fs.readFileSync(file, "utf8");
    return { file, source, code: stripComments(source) };
  })
  .filter(({ code }) => isClientModule(code));

function rel(file: string): string {
  return path.relative(process.cwd(), file);
}

describe("client bundle", () => {
  it("finds the client modules to scan", () => {
    // A refactor that broke the directive detection would otherwise make
    // every assertion below pass vacuously.
    expect(CLIENT_MODULES.length).toBeGreaterThan(20);
    expect(CLIENT_MODULES.map(({ file }) => rel(file))).toContain(
      "src/components/analytics/clarity-analytics.tsx",
    );
  });

  it("reads no environment variable that is not NEXT_PUBLIC_*", () => {
    for (const { file, code } of CLIENT_MODULES) {
      const names = [...code.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map(
        (m) => m[1],
      );
      const leaked = names.filter(
        (name) => !name.startsWith("NEXT_PUBLIC_") && name !== "NODE_ENV",
      );
      expect(
        leaked,
        `${rel(file)} reads ${leaked.join(", ")} in a client component — ` +
          "Next inlines this into the browser bundle",
      ).toEqual([]);
    }
  });

  it("never touches env.server, which throws in the browser anyway", () => {
    for (const { file, code } of CLIENT_MODULES) {
      expect(
        /\benv\.server\b/.test(code),
        `${rel(file)} reads env.server in a client component`,
      ).toBe(false);
    }
  });

  it('never imports "server-only"', () => {
    for (const { file, code } of CLIENT_MODULES) {
      expect(
        /["']server-only["']/.test(code),
        `${rel(file)} imports server-only in a client component`,
      ).toBe(false);
    }
  });

  it("keeps the Clarity gate free of any env access", () => {
    // The project id is threaded in as a prop from the server layout, the
    // same shape as the Turnstile site key. Reading env inside the
    // component would work, but it moves a third-party configuration read
    // out of `@/lib/env` where the schema documents it.
    const gate = CLIENT_MODULES.find(({ file }) =>
      file.endsWith(path.join("analytics", "clarity-analytics.tsx")),
    );
    expect(gate).toBeDefined();
    expect(gate!.code).not.toContain("process.env");
  });
});

describe("Clarity configuration", () => {
  /**
   * The public id must be declared in THREE places to work: the zod schema,
   * the `parseClient()` literal map, and `.env.example`. Next only inlines
   * statically analysable `process.env.X` references, so a schema entry
   * without the matching literal ships a permanently-dead flag that looks
   * exactly like the kill switch working correctly.
   */
  const envSource = fs.readFileSync(path.join(SRC, "lib", "env.ts"), "utf8");

  it("is declared on the public schema, not the server schema", () => {
    expect(envSource).toContain(
      "NEXT_PUBLIC_CLARITY_PROJECT_ID: z.string().optional()",
    );
    const [serverHalf] = envSource.split("const clientSchema");
    expect(serverHalf).not.toContain("CLARITY");
  });

  it("is read as a static literal so Next can inline it", () => {
    expect(envSource).toContain(
      "NEXT_PUBLIC_CLARITY_PROJECT_ID: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID",
    );
  });

  it("is optional, so an unconfigured environment still boots", () => {
    // .env.test and .env.smoke deliberately omit it.
    expect(process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID).toBeUndefined();
  });

  it("ships no real project id in git", () => {
    // The repo's convention is uniform: not even the Firebase web API key
    // or the Turnstile site key are committed with a real value.
    const example = fs.readFileSync(
      path.resolve(process.cwd(), ".env.example"),
      "utf8",
    );
    expect(example).toContain("NEXT_PUBLIC_CLARITY_PROJECT_ID");
    expect(example).toMatch(/#\s*NEXT_PUBLIC_CLARITY_PROJECT_ID=""/);
  });
});
