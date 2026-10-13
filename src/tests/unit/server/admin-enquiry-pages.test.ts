import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for the two new admin enquiry pages.
 *
 * Why source-level: the property is about ORDER, and no render test sees it.
 * A layout `redirect()` does not stop a page rendering — the App Router runs
 * layout and page concurrently and attaches the already-built RSC payload to
 * the 307 — which is exactly how `/admin/users` once returned 51 KB of real
 * user emails alongside its redirect. The fix is that every protected page
 * awaits `requireAdminPage()` BEFORE it reads anything, so that is what this
 * asserts, for the pages that did not exist when that fix landed.
 */

const SRC = path.resolve(process.cwd(), "src");
const PAGES = [
  "app/admin/(protected)/quotations/page.tsx",
  "app/admin/(protected)/quotations/[id]/page.tsx",
];

function read(file: string): string {
  return fs
    .readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe.each(PAGES)("%s", (file) => {
  const code = read(file);

  it("awaits requireAdminPage()", () => {
    expect(code).toContain("await requireAdminPage()");
  });

  it("awaits the guard BEFORE any service call", () => {
    const guard = code.indexOf("await requireAdminPage()");
    expect(guard).toBeGreaterThan(-1);
    for (const call of ["listEnquiries(", "getEnquiry("]) {
      const at = code.indexOf(call);
      if (at === -1) continue;
      expect(at, `${call} runs before the guard in ${file}`).toBeGreaterThan(
        guard,
      );
    }
  });

  it("is force-dynamic, so a protected page is never statically cached", () => {
    expect(code).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("console enquiry service", () => {
  const code = read("console/server/services/quotations.ts");

  it("asserts an admin session in every exported read", () => {
    const exported = [...code.matchAll(/export async function (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(expect.arrayContaining(["listEnquiries", "getEnquiry"]));
    for (const fn of exported) {
      const start = code.indexOf(`export async function ${fn}`);
      const body = code.slice(start, code.indexOf("\n}", start));
      expect(body, `${fn} does not assert an admin session`).toContain(
        "await assertConsoleAdmin()",
      );
    }
  });

  it("never lets a caller widen the query to the waitlist", () => {
    // The exclusion is applied unconditionally; a `source` filter may only
    // narrow within it.
    expect(code).toContain("$nin: EXCLUDED_SOURCES");
    expect(code).toContain("EXCLUDED_SOURCES.includes");
  });

  it("validates the id shape before building an ObjectId", () => {
    const start = code.indexOf("export async function getEnquiry");
    const body = code.slice(start);
    const guard = body.indexOf("OBJECT_ID.test(id)");
    const query = body.indexOf("new Types.ObjectId(id)");
    expect(guard).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(guard);
  });

  it("escapes the search term so a regex cannot be injected", () => {
    expect(code).toMatch(/replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/);
  });
});
