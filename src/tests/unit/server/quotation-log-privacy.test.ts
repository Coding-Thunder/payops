import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A source-level assertion, because the property is about what is ABSENT.
 *
 * `quotation.service` handles a visitor's name, business email, company and
 * free-text message. None of it belongs in an application log: logs are
 * shipped, retained and read by people who have no reason to see a lead's
 * contact details. The record id is the correct handle — it finds the lead in
 * /admin/quotations without copying the PII into a second system.
 *
 * This caught a real regression: the no-transport branch used to log
 * `workEmail`.
 */

const SRC = path.resolve(process.cwd(), "src");
const FILE = "server/services/quotation.service.ts";

/** Field names that identify a person. */
const PII_FIELDS = [
  "workEmail",
  "fullName",
  "companyName",
  "useCase",
  "phone",
  "customRequirements",
  "notes",
];

function logCalls(code: string): string[] {
  // Each `logger.<level>(` call, up to its closing `);`. Crude but the file
  // is small and the calls are formatted one per statement.
  const out: string[] = [];
  const re = /logger\.(warn|error|info|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index;
    const end = code.indexOf("});", start);
    const end2 = code.indexOf(");", start);
    out.push(code.slice(start, (end === -1 ? end2 : Math.min(end, end2)) + 3));
  }
  return out;
}

describe("quotation.service logging carries no PII", () => {
  const raw = fs.readFileSync(path.join(SRC, FILE), "utf8");
  // Strip comments so the explanatory ones above the log calls don't count.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("makes at least one log call (otherwise this test proves nothing)", () => {
    expect(logCalls(code).length).toBeGreaterThan(0);
  });

  it.each(PII_FIELDS)("never passes %s to a logger", (field) => {
    for (const call of logCalls(code)) {
      expect(call, `${field} appears in: ${call}`).not.toContain(field);
    }
  });

  it("identifies the lead by record id instead", () => {
    const calls = logCalls(code).join("\n");
    expect(calls).toContain("quotationId");
  });

  it("does not read SALES_EMAIL as a raw process.env lookup", () => {
    // It is declared in `lib/env` so a typo is an env validation error
    // rather than an empty recipient discovered at send time.
    expect(code).not.toContain("process.env.SALES_EMAIL");
    expect(code).toContain("env.server.SALES_EMAIL");
  });

  it("records a reason when there is nowhere to send, rather than claiming SENT", () => {
    expect(code).toContain("no_recipient_configured");
    // The only place "SENT" is produced is after a successful sendEmail.
    const sentIdx = code.indexOf('status: "SENT"');
    expect(sentIdx).toBeGreaterThan(-1);
    expect(code.slice(0, sentIdx)).toContain("await sendEmail(");
  });
});
