import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `sendEmail` is the single place mail leaves the application, so it is
 * where the header-safety guarantee has to hold — not in each of the
 * eight callers that build a subject.
 */
const resendCalls: Array<{ subject: string }> = [];
const smtpCalls: Array<{ subject: string }> = [];

vi.mock("@/server/email/resend", () => ({
  resendApiKey: () => resendKey,
  deliverViaResend: async (_key: string, payload: { subject: string }) => {
    resendCalls.push(payload);
    return { id: "id" };
  },
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (opts: { subject: string }) => {
      smtpCalls.push(opts);
      return { messageId: "id", response: "ok" };
    },
  }),
}));

let resendKey: string | null = "re_test";

import { sendEmail } from "@/server/email/send";

const base = {
  from: "TraceTxn <no-reply@test.local>",
  to: "jane@abc.test",
  html: "<p>hi</p>",
  kind: "CLIENT_MESSAGE",
};

beforeEach(() => {
  resendCalls.length = 0;
  smtpCalls.length = 0;
  resendKey = "re_test";
});

describe("outbound subject is always a single line", () => {
  it("collapses an embedded CRLF that .trim() would leave in place", async () => {
    await sendEmail({
      ...base,
      subject: "Update\r\nBcc: evil@example.com",
    });
    expect(resendCalls[0].subject).toBe("Update Bcc: evil@example.com");
    expect(resendCalls[0].subject).not.toMatch(/[\r\n]/);
  });

  it("collapses a newline smuggled in through a resolved variable", async () => {
    // e.g. a client record whose name field contains a line break.
    await sendEmail({ ...base, subject: "Re Jane\nBcc: evil@example.com" });
    expect(resendCalls[0].subject).not.toMatch(/[\r\n]/);
  });

  it("applies on the SMTP path too, not just Resend", async () => {
    resendKey = null;
    await sendEmail({ ...base, subject: "Update\r\nX-Injected: yes" });
    expect(smtpCalls[0].subject).toBe("Update X-Injected: yes");
    expect(smtpCalls[0].subject).not.toMatch(/[\r\n]/);
  });

  it("leaves an ordinary subject untouched", async () => {
    await sendEmail({ ...base, subject: "Update on Website Development" });
    expect(resendCalls[0].subject).toBe("Update on Website Development");
  });
});
