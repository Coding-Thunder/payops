import { describe, expect, it } from "vitest";

import { classifyMailError } from "@/server/email/smtp";

describe("classifyMailError", () => {
  it("maps EAUTH / 535 to an auth-credentials message", () => {
    expect(classifyMailError({ code: "EAUTH", responseCode: 535 }).category).toBe(
      "auth",
    );
    expect(classifyMailError({ responseCode: 530 }).category).toBe("auth");
  });

  it("maps a Resend HTTP 401/403 (invalid API key) to auth, not generic retry", () => {
    // The exact outage: Resend rejected the key with 401. It must NOT read as
    // a transient "try again" — it's a config error that won't self-resolve.
    for (const responseCode of [401, 403]) {
      const out = classifyMailError({ responseCode, response: "API key is invalid" });
      expect(out.category).toBe("auth");
      expect(out.message).not.toMatch(/try again/i);
      expect(out.message.toLowerCase()).toMatch(/credential|api key|configuration/);
    }
  });

  it("maps socket/DNS/timeout codes to connection", () => {
    for (const code of ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ENOTFOUND"]) {
      expect(classifyMailError({ code }).category).toBe("connection");
    }
  });

  it("maps 4xx deferrals to throttled", () => {
    for (const responseCode of [421, 450, 451, 452]) {
      expect(classifyMailError({ responseCode }).category).toBe("throttled");
    }
  });

  it("reads quota text as throttled even on a 550 (Gmail daily limit)", () => {
    const err = {
      responseCode: 550,
      response: "550-5.4.5 Daily user sending limit exceeded",
      command: "RCPT TO",
    };
    // Text signal must win over the 550/RCPT recipient bucket.
    expect(classifyMailError(err).category).toBe("throttled");
  });

  it("maps a genuine bad-recipient 550 to recipient", () => {
    const err = {
      responseCode: 550,
      response: "550 5.1.1 The email account that you tried to reach does not exist",
      command: "RCPT TO",
    };
    expect(classifyMailError(err).category).toBe("recipient");
  });

  it("maps EENVELOPE and size rejections", () => {
    expect(classifyMailError({ code: "EENVELOPE" }).category).toBe("recipient");
    expect(classifyMailError({ code: "EMESSAGE" }).category).toBe("message");
    expect(classifyMailError({ responseCode: 552 }).category).toBe("message");
  });

  it("falls back to a generic retry message for unknown shapes", () => {
    const out = classifyMailError(new Error("kaboom"));
    expect(out.category).toBe("unknown");
    expect(out.message).toMatch(/try again/i);
  });

  it("never echoes the raw SMTP response in the operator message", () => {
    const secret = "550 relay denied for user internal-mailbox-7f3a@corp.local";
    const out = classifyMailError({ responseCode: 550, response: secret });
    expect(out.message).not.toContain("internal-mailbox-7f3a");
    expect(out.message).not.toContain("corp.local");
  });
});
