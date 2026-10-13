import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The retention SCHEDULE, asserted from the repository.
 *
 * Why this exists: the privacy policy promises enquiries are "deleted
 * automatically" after 180 days. That promise is only true if something
 * actually runs the purge on a schedule. A code review can confirm the purge
 * is correct and still ship a false promise, because the scheduler is a YAML
 * file nobody type-checks.
 *
 * This cannot execute the workflow — GitHub does that — so it verifies the
 * chain the workflow depends on: the npm script exists, it invokes the real
 * runner, the runner calls the real purge, and the workflow invokes that npm
 * script on a daily cron with overlap protection. Each link is a thing that
 * has silently broken in other projects.
 */

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, ".github/workflows/retention.yml");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("retention schedule — the chain from cron to delete", () => {
  const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as {
    scripts: Record<string, string>;
  };

  it("exposes a retention:prod script", () => {
    expect(pkg.scripts["retention:prod"]).toBeTruthy();
  });

  it("the script runs the real runner, with the server-only shim", () => {
    const cmd = pkg.scripts["retention:prod"];
    expect(cmd).toContain("scripts/run-retention.ts");
    // The service files are `import "server-only"`; without the shim the
    // runner throws on import rather than purging anything.
    expect(cmd).toContain("shim-server-only.cjs");
    // No --env-file: production env comes from the environment, matching the
    // other :prod scripts.
    expect(cmd).not.toContain("--env-file");
  });

  it("the runner invokes the enquiry purge, not just the email one", () => {
    const runner = read(path.join(ROOT, "scripts/run-retention.ts"));
    expect(runner).toContain("purgeOldEnquiries");
    expect(runner).toContain("await purgeOldEnquiries(");
    // Counted into the summary, so a silent zero is visible.
    expect(runner).toMatch(/enquiries\.deleted/);
  });

  it("the purge still scopes to contact_sales at 180 days", () => {
    const svc = read(
      path.join(ROOT, "src/server/services/retention.service.ts"),
    );
    expect(svc).toContain("ENQUIRY_RETENTION_DAYS = 180");
    expect(svc).toContain("source: GENERAL_ENQUIRY_SOURCE");
    // Strictly older-than, and never a bare date sweep.
    expect(svc).toContain("$lt: cutoff");
    expect(svc).not.toMatch(/deleteMany\(\{\s*createdAt/);
  });
});

describe("retention workflow", () => {
  const raw = read(WORKFLOW);

  it("exists and runs the npm script", () => {
    expect(raw).toContain("npm run retention:prod");
  });

  it("is scheduled daily", () => {
    const cron = raw.match(/cron:\s*"([^"]+)"/)?.[1];
    expect(cron).toBeTruthy();
    const fields = (cron ?? "").trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [, , dom, month, dow] = fields;
    // Every day: no day-of-month, month or weekday restriction.
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);
  });

  it("can be run by hand to verify configuration", () => {
    expect(raw).toContain("workflow_dispatch");
  });

  it("prevents overlapping runs without killing one in flight", () => {
    expect(raw).toMatch(/concurrency:\s*\n\s*group:\s*retention/);
    expect(raw).toContain("cancel-in-progress: false");
  });

  it("takes least-privilege permissions and a timeout", () => {
    expect(raw).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(raw).toMatch(/timeout-minutes:\s*\d+/);
  });

  it("fails loudly when the database is not configured", () => {
    // Without this an unconfigured schedule "succeeds" nightly having
    // deleted nothing, and the policy's promise is quietly false.
    expect(raw).toContain("is not configured");
    expect(raw).toContain("::error::");
  });

  it("never echoes a secret value", () => {
    expect(raw).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });

  it("pins a node version matching package.json engines", () => {
    const pinned = raw.match(/node-version:\s*([\d.x]+)/)?.[1];
    const engines = (
      JSON.parse(read(path.join(ROOT, "package.json"))) as {
        engines?: { node?: string };
      }
    ).engines?.node;
    expect(pinned).toBeTruthy();
    expect(pinned).toBe(engines);
  });
});
