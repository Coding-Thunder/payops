import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoogleTagManager } from "@/components/analytics/google-tag-manager";
import {
  gtmBootstrapScript,
  gtmNoscriptSrc,
  isValidGtmContainerId,
} from "@/lib/analytics/gtm";
import { renderWithUser } from "@/tests/utils/render";

/**
 * Google Tag Manager.
 *
 * Three properties matter here, and each has a failure mode that is silent:
 *
 *   1. NO CONTAINER ID → NOTHING RENDERS. `.env.test`, `.env.smoke`, local dev
 *      and CI all leave it unset; they must behave exactly as before GTM
 *      existed. A hardcoded id would fire the real container from every test
 *      run, which is why the id is asserted to come from a prop.
 *   2. BOTH HALVES OR NEITHER. Google's install is two snippets. Shipping the
 *      script without the noscript, or with a stale id in one of them, looks
 *      fine and half-works.
 *   3. THE DATA-LAYER NAME IS LOAD-BEARING. The published container declares
 *      `"19":"dataLayer"`. Renaming the variable makes the container receive
 *      nothing at all, silently — no error, no data.
 */

const CONTAINER = "GTM-TEST1234";
const SRC = path.resolve(process.cwd(), "src");

function scripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll("script#gtm-bootstrap"));
}

describe("isValidGtmContainerId", () => {
  it("accepts a real-shaped container id", () => {
    // Fixtures, not the live container id. This repo commits no real
    // NEXT_PUBLIC_* value — not the Firebase key, not the Turnstile site key,
    // not this. The live id lives only in the gitignored env mirror and the
    // DigitalOcean env panel.
    expect(isValidGtmContainerId("GTM-EXAMPLE1")).toBe(true);
    expect(isValidGtmContainerId("GTM-ABCD")).toBe(true);
  });

  it("rejects a GA4 measurement id pasted into the container field", () => {
    // The most common install mistake: G-XXXXXXX is a *measurement* id. It
    // would 400 at Google and read as "GTM just doesn't work".
    expect(isValidGtmContainerId("G-ABCD1234")).toBe(false);
  });

  it("rejects anything that is not GTM- plus uppercase alphanumerics", () => {
    // The id is interpolated into an inline <script>, so this is a security
    // boundary, not a typo check.
    for (const bad of [
      "",
      "   ",
      "GTM-",
      "GTM-abc1",
      "gtm-ABCD1234",
      "GTM ABCD",
      "GTM-ABC!",
      '"); alert(1);//',
      "</script><script>alert(1)</script>",
      null,
      undefined,
    ]) {
      expect(isValidGtmContainerId(bad as string), String(bad)).toBe(false);
    }
  });
});

describe("gtmBootstrapScript", () => {
  const snippet = gtmBootstrapScript(CONTAINER);

  it("is Google's official snippet", () => {
    expect(snippet).toContain("w[l]=w[l]||[]");
    expect(snippet).toContain("'gtm.start'");
    expect(snippet).toContain("event:'gtm.js'");
    expect(snippet).toContain("https://www.googletagmanager.com/gtm.js?id=");
    expect(snippet).toContain("j.async=true");
  });

  it("keeps the data-layer variable named dataLayer", () => {
    // Non-obvious and load-bearing — see the file header.
    expect(snippet).toContain("'script','dataLayer'");
  });

  it("embeds the id JSON-escaped", () => {
    expect(snippet).toContain(`"${CONTAINER}"`);
  });

  it("refuses a malformed id rather than emitting script content", () => {
    expect(() => gtmBootstrapScript("G-ABCD1234")).toThrow(/malformed/i);
    expect(() => gtmBootstrapScript('"); alert(1);//')).toThrow(/malformed/i);
    expect(() => gtmNoscriptSrc("")).toThrow(/malformed/i);
  });

  it("points the noscript iframe at ns.html for the same container", () => {
    expect(gtmNoscriptSrc(CONTAINER)).toBe(
      `https://www.googletagmanager.com/ns.html?id=${CONTAINER}`,
    );
  });
});

describe("GoogleTagManager — kill switch", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a GA4 measurement id", "G-ABCD1234"],
    ["malformed", "not-a-container"],
  ])("renders nothing for %s", (_label, id) => {
    const { container } = renderWithUser(<GoogleTagManager containerId={id} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("makes no network reference when disabled", () => {
    const { container } = renderWithUser(
      <GoogleTagManager containerId={undefined} />,
    );
    expect(container.innerHTML).not.toContain("googletagmanager");
  });
});

describe("GoogleTagManager — enabled", () => {
  /**
   * The noscript half is asserted against SERVER-rendered markup, not a
   * client render. React does not render <noscript> CHILDREN on the client —
   * a client render yields an empty <noscript></noscript> — so a
   * `render()`-based assertion would silently pass on a component that ships
   * no iframe at all. Server markup is also the only place the noscript
   * matters: it exists for visitors and crawlers that never run JavaScript.
   */
  const ssr = (id: string) =>
    renderToStaticMarkup(<GoogleTagManager containerId={id} />);

  it("renders BOTH halves: the bootstrap script and the noscript iframe", () => {
    const html = ssr(CONTAINER);
    expect(html).toContain("<script");
    expect(html).toContain("googletagmanager.com/gtm.js?id=");
    expect(html).toContain("<noscript>");
    expect(html).toContain("<iframe");
    expect(html).toContain("/ns.html?id=");
  });

  it("puts the iframe inside the noscript, never bare", () => {
    // A bare iframe would load for every visitor — a different, worse thing.
    expect(ssr(CONTAINER)).toMatch(/<noscript><iframe[^>]*googletagmanager[^>]*>/);
  });

  it("uses the same container id in both halves", () => {
    // Catches the copy-paste bug where one half keeps a stale id.
    const html = ssr(CONTAINER);
    const inScript = html.match(/gtm\.js\?id='\+i\+dl[\s\S]*?"(GTM-[A-Z0-9]+)"/)?.[1];
    const inFrame = html.match(/ns\.html\?id=(GTM-[A-Z0-9]+)/)?.[1];
    expect(inScript).toBe(CONTAINER);
    expect(inFrame).toBe(CONTAINER);
  });

  it("renders the id it is given, not a baked-in one", () => {
    renderWithUser(<GoogleTagManager containerId="GTM-FROMPROP1" />);
    expect(scripts()[0].innerHTML).toContain("GTM-FROMPROP1");
    expect(ssr("GTM-FROMPROP1")).toContain("GTM-FROMPROP1");
  });

  it("hides the noscript iframe so it never affects layout", () => {
    const html = ssr(CONTAINER);
    expect(html).toMatch(/height="0"/);
    expect(html).toMatch(/width="0"/);
    expect(html).toMatch(/display:\s*none/);
    expect(html).toMatch(/visibility:\s*hidden/);
  });

  it("is server-renderable — no client directive, no env read", () => {
    // It must render into the SSR HTML so curl and no-JS visitors see it.
    // next/script with inline content emits zero bytes server-side, which is
    // why this component uses a raw <script>.
    const raw = fs.readFileSync(
      path.join(SRC, "components/analytics/google-tag-manager.tsx"),
      "utf8",
    );
    // Strip comments first: this file DOCUMENTS why it avoids next/script and
    // process.env, and matching prose would fail on the explanation.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*["']use client["']/m);
    expect(code).not.toContain("next/script");
    // Every process.env read stays inside @/lib/env; the id arrives as a prop.
    expect(code).not.toContain("process.env");
  });
});

describe("no container id is hardcoded in the source", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["tests", "node_modules", ".next"].includes(e.name)) continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }

  it("reads the container id from the environment, never a literal", () => {
    // The component test above passes happily if the component ALSO falls
    // back to a literal; only a static scan catches that.
    const offenders = walk(SRC).filter((f) =>
      /GTM-[A-Z0-9]{4,}/.test(
        fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
      ),
    );
    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      "container id must come from NEXT_PUBLIC_GTM_CONTAINER_ID",
    ).toEqual([]);
  });
});
