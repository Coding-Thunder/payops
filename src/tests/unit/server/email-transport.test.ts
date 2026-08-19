import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the production console-login outage.
 *
 * `src/server/email/resend.ts` existed and `/api/health` probed the Resend
 * key over HTTPS (reporting "healthy"), but nothing in production code ever
 * called `deliverViaResend` — every real send still opened an SMTP socket
 * with that same `re_…` credential, which Resend's SMTP gateway answered with
 * `535 Authentication credentials invalid`. Green health check, zero
 * delivered mail: sign-in OTPs, password resets and lead notifications alike.
 *
 * These tests pin the invariant that fixes it: when a Resend key is present,
 * delivery goes over HTTPS and the SMTP transport is never even constructed.
 */

const serverEnv: Record<string, unknown> = {};
vi.mock("@/lib/env", () => ({ env: { server: serverEnv, public: {} } }));

const getMailer = vi.fn();
vi.mock("@/server/email/smtp", () => ({ getMailer }));

const MSG = {
  from: "TraceTxn <accounts@tracetxn.com>",
  to: "operator@example.com",
  subject: "TraceTxn Admin sign-in code: 123456",
  html: "<p>123456</p>",
  text: "123456",
  kind: "ADMIN_OTP",
};

beforeEach(() => {
  for (const k of Object.keys(serverEnv)) delete serverEnv[k];
  getMailer.mockReset().mockReturnValue(null);
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = { id: "msg_1" }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendEmail transport selection", () => {
  it("uses Resend HTTPS when SMTP_PASS is a re_ key, and never builds an SMTP transport", async () => {
    // Exactly the production config: no RESEND_API_KEY, SMTP_* pointed at
    // smtp.resend.com with the API key as the password.
    serverEnv.SMTP_HOST = "smtp.resend.com";
    serverEnv.SMTP_USER = "resend";
    serverEnv.SMTP_PASS = "re_test_0123456789abcdef";
    const fetchMock = stubFetch();

    const { sendEmail } = await import("@/server/email/send");
    const result = await sendEmail(MSG);

    expect(result).toEqual({
      messageId: "msg_1",
      transport: "resend-http",
      response: "resend-http",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    // The heart of the bug: the SMTP path must not even be reached.
    expect(getMailer).not.toHaveBeenCalled();
  });

  it("prefers an explicit RESEND_API_KEY over SMTP_PASS", async () => {
    serverEnv.RESEND_API_KEY = "re_explicit_key_value";
    serverEnv.SMTP_PASS = "re_fallback_key_value";
    const fetchMock = stubFetch();

    const { sendEmail } = await import("@/server/email/send");
    await sendEmail(MSG);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_explicit_key_value",
    );
  });

  it("carries the entity kind and any extra headers through the HTTP payload", async () => {
    serverEnv.RESEND_API_KEY = "re_k";
    const fetchMock = stubFetch();

    const { sendEmail } = await import("@/server/email/send");
    await sendEmail({ ...MSG, headers: { "X-TraceTxn-Lead": "abc123" } });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.headers).toEqual({
      "X-Entity-Kind": "ADMIN_OTP",
      "X-TraceTxn-Lead": "abc123",
    });
  });

  it("surfaces a rejected key as a throw, never a false success", async () => {
    serverEnv.RESEND_API_KEY = "re_revoked";
    stubFetch(401, { message: "API key is invalid" });

    const { sendEmail } = await import("@/server/email/send");
    // A silent resolve here is what let the console report `sent: true`
    // while the operator waited for an email that never existed.
    await expect(sendEmail(MSG)).rejects.toMatchObject({ responseCode: 401 });
  });

  it("falls back to SMTP only when no re_ key is configured", async () => {
    serverEnv.SMTP_HOST = "smtp.example.com";
    serverEnv.SMTP_USER = "postmaster@example.com";
    serverEnv.SMTP_PASS = "not-a-resend-key";
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<smtp-1>" });
    getMailer.mockReturnValue({ sendMail });
    const fetchMock = stubFetch();

    const { sendEmail } = await import("@/server/email/send");
    const result = await sendEmail(MSG);

    expect(result).toEqual({
      messageId: "<smtp-1>",
      transport: "smtp",
      response: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail.mock.calls[0][0].headers).toEqual({
      "X-Entity-Kind": "ADMIN_OTP",
    });
  });

  it("throws EmailNotConfiguredError when no transport is available at all", async () => {
    const { sendEmail, EmailNotConfiguredError } = await import(
      "@/server/email/send"
    );
    await expect(sendEmail(MSG)).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    );
  });
});

describe("isEmailConfigured", () => {
  it("is true with only a Resend key and no SMTP host", async () => {
    // The console's old guard was `getMailer() !== null`, which is false in
    // this configuration — so a Resend-only deployment would refuse to send.
    serverEnv.RESEND_API_KEY = "re_k";
    const { isEmailConfigured } = await import("@/server/email/send");
    expect(isEmailConfigured()).toBe(true);
  });

  it("is false when nothing is configured", async () => {
    const { isEmailConfigured } = await import("@/server/email/send");
    expect(isEmailConfigured()).toBe(false);
  });
});
