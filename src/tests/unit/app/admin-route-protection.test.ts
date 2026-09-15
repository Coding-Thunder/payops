// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression tests for the admin PII disclosure.
 *
 * ── The bug these exist to prevent ───────────────────────────────────────
 *
 * An unauthenticated GET of any `/admin/(protected)/**` page returned HTTP 307
 * to the console login — AND the fully-rendered admin page in the response
 * body. A browser follows the Location header and throws the body away, which
 * is exactly why it survived manual testing; `curl`, a crawler, a logging
 * proxy or any non-browser client reads it.
 *
 * Measured on production before the fix: `/admin/users` returned 307 with
 * 51 KB containing 16 real user email addresses. The console's review pages
 * would additionally have leaked reviewer emails, their submitting IP and the
 * internal moderation note.
 *
 * ── Why it happened, and therefore what to assert ────────────────────────
 *
 * The only guard was `requireAdminPage()` in the protected LAYOUT. A layout
 * `redirect()` does not stop the page rendering: the App Router renders layout
 * and page concurrently, so the payload already exists when the redirect is
 * emitted. The control that proved this was `/admin/admins`, the one page that
 * happened to call `requireAdminPage()` in its own body — it leaked nothing,
 * with the same 307.
 *
 * So there are exactly two things worth pinning, and a behavioural test of one
 * page would pin neither:
 *
 *   1. `src/proxy.ts` refuses the request BEFORE anything renders.
 *   2. EVERY protected page also awaits the guard before it reads data, so it
 *      is safe even if the proxy is bypassed or its matcher changes.
 *
 * (2) is a structural property of a whole directory. A new page added next
 * month is the realistic regression, and only a filesystem sweep catches it —
 * which is why these are source assertions rather than render tests. The live
 * HTTP behaviour is verified separately against a running server.
 */

const ROOT = process.cwd();
const PROTECTED_DIR = path.join(ROOT, "src/app/admin/(protected)");
const PROXY = path.join(ROOT, "src/proxy.ts");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function protectedPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") out.push(full);
    }
  };
  walk(PROTECTED_DIR);
  return out.sort();
}

describe("every protected console page guards itself", () => {
  const pages = protectedPages();

  it("finds the protected pages at all (guards against a moved directory)", () => {
    // If this ever hits zero the sweep below passes vacuously, which would be
    // the worst possible failure mode for a security test.
    expect(pages.length).toBeGreaterThanOrEqual(15);
  });

  it.each(pages.map((p) => [path.relative(PROTECTED_DIR, p), p]))(
    "%s awaits requireAdminPage()",
    (_rel, file) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      expect(code).toContain("requireAdminPage");
      expect(code).toMatch(/await\s+requireAdminPage\(\)/);
    },
  );

  it.each(pages.map((p) => [path.relative(PROTECTED_DIR, p), p]))(
    "%s awaits the guard BEFORE it reads any data",
    (rel, file) => {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      const guard = code.search(/await\s+requireAdminPage\(\)/);
      expect(guard, `${rel} never awaits the guard`).toBeGreaterThan(-1);

      // Any awaited service call: list*/get*/count*/other*. Awaiting a query
      // before the guard is what put rendered rows into the 307 body.
      const firstRead = code.search(
        /await\s+(list|get|count|other)[A-Z]\w*\(/,
      );
      if (firstRead !== -1) {
        expect(
          guard,
          `${rel} reads data at index ${firstRead} before guarding at ${guard}`,
        ).toBeLessThan(firstRead);
      }
    },
  );

  it("the protected layout still guards too — the outer layer is not removed", () => {
    const layout = fs.readFileSync(
      path.join(PROTECTED_DIR, "layout.tsx"),
      "utf8",
    );
    expect(stripComments(layout)).toMatch(/await\s+requireAdminPage\(\)/);
  });
});

describe("the proxy refuses console requests before anything renders", () => {
  const proxy = fs.readFileSync(PROXY, "utf8");
  const code = stripComments(proxy);

  it("verifies an admin session for console paths", () => {
    expect(code).toContain("hasAdminSession");
    expect(code).toContain("admin_session");
    // Signature, issuer AND audience — a token minted for the tenant app must
    // not open the console.
    expect(code).toContain("tracetxn-admin");
    expect(code).toContain("tracetxn-admin:web");
    expect(code).toMatch(/jwtVerify\(/);
  });

  it("gates the console branch on that check", () => {
    // The gate must sit inside the isPlatformConsole branch and short-circuit
    // it — not merely exist somewhere in the file.
    const branch = code.slice(code.indexOf("if (isPlatformConsole(pathname))"));
    const guardAt = branch.indexOf("hasAdminSession");
    const passThroughAt = branch.indexOf("x-console-path");
    expect(guardAt).toBeGreaterThan(-1);
    expect(
      guardAt,
      "the session check must precede the pass-through",
    ).toBeLessThan(passThroughAt);
  });

  it("exempts ONLY the login page and the credential endpoints", () => {
    expect(code).toContain("isConsolePublic");
    const fn = code.slice(
      code.indexOf("function isConsolePublic"),
      code.indexOf("function hasAdminSession"),
    );
    expect(fn).toContain('"/admin"');
    expect(fn).toContain("/admin/api/auth/");
    // A prefix exemption for the whole API surface would re-open every
    // console endpoint to anonymous callers.
    expect(fn).not.toMatch(/startsWith\(["']\/admin\/api\/["']\)/);
    expect(fn).not.toMatch(/startsWith\(["']\/admin\/["']\)/);
  });

  it("answers a route handler with 401 JSON, not a redirect", () => {
    // A 307 on an API route would be followed by fetch() and hand the client
    // an HTML login page where it expected JSON.
    const branch = code.slice(code.indexOf("if (isPlatformConsole(pathname))"));
    expect(branch).toContain("/admin/api/");
    expect(branch).toMatch(/status:\s*401/);
    expect(branch).toContain("UNAUTHORIZED");
  });

  it("still allows /admin (the login page) through unauthenticated", () => {
    // The regression that would lock every operator out of their own console.
    const fn = code.slice(
      code.indexOf("function isConsolePublic"),
      code.indexOf("function hasAdminSession"),
    );
    expect(fn).toMatch(/pathname === ["']\/admin["']/);
  });

  it("does not re-check the allow-list in the proxy", () => {
    // Deliberate: that is a database read on every request. The DB check stays
    // in getAdminEmail(), which still runs afterwards — so this must not be
    // "optimised" into the middleware later.
    const fn = code.slice(code.indexOf("async function hasAdminSession"));
    expect(fn.slice(0, 600)).not.toContain("isAllowedEmail");
    expect(fn.slice(0, 600)).not.toContain("connectMongo");
  });
});
