import fs from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    server: {},
    public: {
      NEXT_PUBLIC_APP_NAME: "TraceTxn",
      NEXT_PUBLIC_APP_URL: "https://tracetxn.test",
    },
  },
}));

/**
 * The client-management SEO cluster.
 *
 * These pin the properties that decide whether the cluster works at all, and
 * that are easy to break without noticing:
 *
 *   - every registered page actually EXISTS as a route (a sitemap entry for a
 *     404 is worse than no entry);
 *   - titles, descriptions and canonicals are UNIQUE and self-referencing;
 *   - the sitemap is derived, so a new page cannot be published without being
 *     discoverable, and NO private route can leak into it;
 *   - the pillar links to every spoke and each spoke links back;
 *   - no page claims a capability the product does not have.
 *
 * The last one continues the discipline `seo-claims.test.ts` established: the
 * spec that requested these pages asked the homepage to advertise "approvals",
 * and there is no approvals model, service, route or UI in this codebase. The
 * denylist below is the same one, applied to the new surfaces.
 */

const SRC = path.resolve(process.cwd(), "src");

/** Capabilities the product does NOT implement. Kept in sync with
 *  `seo-claims.test.ts` — delete an entry the day the feature ships. */
const UNIMPLEMENTED = [/approvals?\b/i, /e-?signature/i, /sign-?off/i];

async function seo() {
  return import("@/lib/seo");
}

describe("SEO landing-page registry", () => {
  it("registers the five required cluster pages", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    expect(SEO_LANDING_PAGES.map((p) => p.path)).toEqual([
      "/client-management",
      "/client-management-software",
      "/agency-client-management",
      "/client-communication-management",
      "/client-record-management",
    ]);
  });

  it("uses clean, lowercase, hyphenated, trailing-slash-free paths", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      expect(p.path, p.path).toMatch(/^\/[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.path.endsWith("/")).toBe(false);
      expect(p.path).not.toContain("?");
      expect(p.path).not.toMatch(/[A-Z_]/);
    }
  });

  it("every registered page has a real route file", async () => {
    // A sitemap entry pointing at a 404 is an actively harmful signal.
    const { SEO_LANDING_PAGES } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      const file = path.join(SRC, "app", p.path.slice(1), "page.tsx");
      expect(fs.existsSync(file), `missing route file for ${p.path}`).toBe(true);
    }
  });

  it("has a unique title and description per page", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    const titles = SEO_LANDING_PAGES.map((p) => p.title);
    const descriptions = SEO_LANDING_PAGES.map((p) => p.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("writes descriptions of a usable length", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      expect(p.description.length, `${p.path} too short`).toBeGreaterThan(80);
      expect(p.description.length, `${p.path} too long`).toBeLessThan(260);
    }
  });

  it("claims no capability the product does not have", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      for (const pattern of UNIMPLEMENTED) {
        expect(
          `${p.title} ${p.description}`,
          `${p.path} claims something the app cannot do (${pattern})`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("exposes the spokes as everything but the pillar", async () => {
    const { CLIENT_MANAGEMENT_SPOKES, CLIENT_MANAGEMENT_PATH, SEO_LANDING_PAGES } =
      await seo();
    expect(CLIENT_MANAGEMENT_SPOKES).toHaveLength(SEO_LANDING_PAGES.length - 1);
    expect(
      CLIENT_MANAGEMENT_SPOKES.some((p) => p.path === CLIENT_MANAGEMENT_PATH),
    ).toBe(false);
  });

  it("throws rather than silently returning nothing for an unknown path", async () => {
    const { landingPage } = await seo();
    expect(() => landingPage("/not-a-page")).toThrow(/No SEO landing page/);
  });
});

describe("page metadata", () => {
  it("gives every landing page a self-referencing canonical", async () => {
    const { SEO_LANDING_PAGES, pageMetadata, absoluteUrl } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      const meta = pageMetadata({
        title: p.title,
        description: p.description,
        path: p.path,
      });
      expect(meta.alternates?.canonical).toBe(absoluteUrl(p.path));
    }
  });

  it("leaves landing pages indexable", async () => {
    const { SEO_LANDING_PAGES, pageMetadata } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      const meta = pageMetadata({
        title: p.title,
        description: p.description,
        path: p.path,
      });
      // pageMetadata only sets `robots` for noindex pages; absence == indexable.
      expect(meta.robots, `${p.path} must be indexable`).toBeUndefined();
    }
  });
});

describe("sitemap", () => {
  async function entries() {
    const mod = await import("@/app/sitemap");
    return mod.default();
  }

  it("contains every landing page, derived rather than hand-listed", async () => {
    const { SEO_LANDING_PAGES, absoluteUrl } = await seo();
    const urls = (await entries()).map((e) => e.url);
    for (const p of SEO_LANDING_PAGES) {
      expect(urls, `${p.path} missing from sitemap`).toContain(
        absoluteUrl(p.path),
      );
    }
  });

  it("contains no duplicate URLs", async () => {
    const urls = (await entries()).map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("lists no private, authed, tokenised or noindex route", async () => {
    // The rule this file exists to protect: private client data must never be
    // advertised for crawling.
    const urls = (await entries()).map((e) => e.url);
    for (const forbidden of [
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/join",
      "/activate",
      "/pay",
      "/consent",
      "/app",
      "/admin",
      "/api",
    ]) {
      for (const url of urls) {
        expect(
          new URL(url).pathname === forbidden ||
            new URL(url).pathname.startsWith(`${forbidden}/`),
          `${url} must not be in the sitemap`,
        ).toBe(false);
      }
    }
  });

  it("uses absolute, canonical, trailing-slash-free URLs (except the root)", async () => {
    for (const e of await entries()) {
      expect(e.url).toMatch(/^https?:\/\//);
      const { pathname } = new URL(e.url);
      if (pathname !== "/") expect(pathname.endsWith("/")).toBe(false);
    }
  });
});

describe("robots.txt", () => {
  async function robotsTxt() {
    const mod = await import("@/app/robots");
    return mod.default();
  }

  it("advertises the sitemap", async () => {
    const r = await robotsTxt();
    expect(r.sitemap).toBe("https://tracetxn.test/sitemap.xml");
  });

  it("allows crawling of the public site", async () => {
    const r = await robotsTxt();
    const main = (Array.isArray(r.rules) ? r.rules : [r.rules]).find(
      (rule) => rule?.userAgent === "*",
    );
    expect(main?.allow).toBe("/");
  });

  it("does not disallow any landing page or a rendering asset", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    const r = await robotsTxt();
    const main = (Array.isArray(r.rules) ? r.rules : [r.rules]).find(
      (rule) => rule?.userAgent === "*",
    );
    const disallow = ([] as string[]).concat(main?.disallow ?? []);
    for (const p of SEO_LANDING_PAGES) {
      for (const d of disallow) {
        expect(p.path.startsWith(d), `${p.path} blocked by "${d}"`).toBe(false);
      }
    }
    // Next serves CSS/JS from /_next/static — blocking it would stop Google
    // rendering the pages at all.
    for (const d of disallow) {
      expect("/_next/static/chunk.js".startsWith(d)).toBe(false);
    }
  });

  it("still keeps private surfaces out of the crawl", async () => {
    const r = await robotsTxt();
    const main = (Array.isArray(r.rules) ? r.rules : [r.rules]).find(
      (rule) => rule?.userAgent === "*",
    );
    const disallow = ([] as string[]).concat(main?.disallow ?? []);
    for (const required of ["/api/", "/app/", "/admin", "/pay/", "/consent/"]) {
      expect(disallow, `${required} must stay disallowed`).toContain(required);
    }
  });
});

describe("internal linking", () => {
  /**
   * Rendered anchors, not source text. An earlier version of this grepped the
   * page files and failed on a spoke that linked back through the
   * CLIENT_MANAGEMENT_PATH constant — the link was there, the grep was wrong.
   * What matters is the href a crawler receives.
   */
  async function anchorsOf(routePath: string): Promise<string[]> {
    const mod = await import(`@/app${routePath}/page`);
    const { container } = render(mod.default());
    return Array.from(container.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => typeof h === "string");
  }

  it("links the pillar to every spoke", async () => {
    const { CLIENT_MANAGEMENT_PATH, CLIENT_MANAGEMENT_SPOKES } = await seo();
    const hrefs = await anchorsOf(CLIENT_MANAGEMENT_PATH);
    for (const spoke of CLIENT_MANAGEMENT_SPOKES) {
      expect(hrefs, `pillar does not link to ${spoke.path}`).toContain(
        spoke.path,
      );
    }
  });

  it("links every spoke back to the pillar", async () => {
    const { CLIENT_MANAGEMENT_PATH, CLIENT_MANAGEMENT_SPOKES } = await seo();
    for (const spoke of CLIENT_MANAGEMENT_SPOKES) {
      const hrefs = await anchorsOf(spoke.path);
      expect(hrefs, `${spoke.path} does not link back to the pillar`).toContain(
        CLIENT_MANAGEMENT_PATH,
      );
    }
  });

  it("keeps every cluster page one click from every other", async () => {
    // The footer carries the whole cluster, so the graph is complete rather
    // than a chain that buries the last page five hops deep.
    const { SEO_LANDING_PAGES } = await seo();
    for (const page of SEO_LANDING_PAGES) {
      const hrefs = new Set(await anchorsOf(page.path));
      for (const other of SEO_LANDING_PAGES) {
        if (other.path === page.path) continue;
        expect(hrefs.has(other.path), `${page.path} → ${other.path}`).toBe(true);
      }
    }
  });

  it("does not offer the current page as further reading", async () => {
    // The footer legitimately lists every cluster page; the "Keep reading"
    // cards must not send a reader back to where they already are.
    const { SEO_LANDING_PAGES } = await seo();
    for (const page of SEO_LANDING_PAGES) {
      const mod = await import(`@/app${page.path}/page`);
      const { container } = render(mod.default());
      const heading = Array.from(container.querySelectorAll("h2")).find((h) =>
        /keep reading/i.test(h.textContent ?? ""),
      );
      const section = heading?.closest("section");
      expect(section, `${page.path} has no further-reading section`).toBeTruthy();
      const hrefs = Array.from(section!.querySelectorAll("a")).map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs, `${page.path} links to itself`).not.toContain(page.path);
    }
  });

  it("gives every landing page exactly one H1", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    for (const page of SEO_LANDING_PAGES) {
      const mod = await import(`@/app${page.path}/page`);
      const { container } = render(mod.default());
      expect(
        container.querySelectorAll("h1").length,
        `${page.path} H1 count`,
      ).toBe(1);
    }
  });

  it("emits BreadcrumbList JSON-LD that resolves to the page itself", async () => {
    const { SEO_LANDING_PAGES, absoluteUrl, CLIENT_MANAGEMENT_PATH } =
      await seo();
    for (const page of SEO_LANDING_PAGES) {
      const mod = await import(`@/app${page.path}/page`);
      const { container } = render(mod.default());
      const node = container.querySelector(
        'script[type="application/ld+json"]',
      );
      expect(node, `${page.path} has no JSON-LD`).toBeTruthy();
      const json = JSON.parse(node!.textContent ?? "{}");
      expect(json["@type"]).toBe("BreadcrumbList");
      const items = json.itemListElement as { position: number; item: string }[];
      // Home → Client management (→ this page, for a spoke).
      expect(items[0].item).toBe(absoluteUrl("/"));
      expect(items[items.length - 1].item).toBe(absoluteUrl(page.path));
      expect(items.length).toBe(page.path === CLIENT_MANAGEMENT_PATH ? 2 : 3);
      items.forEach((it, i) => expect(it.position).toBe(i + 1));
    }
  });

  it("links the homepage to the pillar", async () => {
    const { CLIENT_MANAGEMENT_PATH } = await seo();
    const footer = fs.readFileSync(
      path.join(SRC, "components/marketing/home/site-footer.tsx"),
      "utf8",
    );
    expect(footer).toContain(CLIENT_MANAGEMENT_PATH);
  });
});

describe("crawlability — the proxy must treat landing pages as public", () => {
  /**
   * The regression this exists for: `src/proxy.ts` is deny-by-default, so a
   * route missing from its public allow-list is 307'd to /login. The first
   * version of these five pages shipped exactly that way — indexable
   * metadata, a sitemap entry, and a redirect to a sign-in form for every
   * crawler that followed it. Nothing in the page files themselves would have
   * shown it.
   */
  async function proxyFor(pathname: string) {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    return proxy(new NextRequest(`https://tracetxn.test${pathname}`));
  }

  it("does not redirect any registered landing page", async () => {
    const { SEO_LANDING_PAGES } = await seo();
    for (const p of SEO_LANDING_PAGES) {
      const res = await proxyFor(p.path);
      expect(
        res.headers.get("location"),
        `${p.path} is redirected by the proxy — it would be uncrawlable`,
      ).toBeNull();
      expect(res.status, `${p.path} status`).toBeLessThan(300);
    }
  });

  it("still gates a private route, so the allow-list was not widened", async () => {
    // Guards against "fixing" the above by making the proxy permissive.
    const res = await proxyFor("/app/dashboard");
    expect(res.headers.get("location")).toContain("/login");
  });
});
