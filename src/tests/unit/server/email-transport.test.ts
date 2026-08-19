import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the production console-login outage.
 *
 * The move to Resend's HTTP API was applied to `email.service.tsx` and
 * nowhere else. Three senders — the console's four mails, password reset and
 * the quotation lead alert — kept their own nodemailer call and went on
 * opening an SMTP socket with that same `re_…` credential, which Resend's
 * SMTP gateway answers with `535 Authentication credentials invalid`.
 * Meanwhile `/api/health` probed the key over HTTPS and reported "healthy".
 * Green health check, zero delivered mail.
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

describe("resendKeySource — names the env var, never the key", () => {
  it("reports RESEND_API_KEY when one is set", async () => {
    serverEnv.RESEND_API_KEY = "re_explicit";
    serverEnv.SMTP_PASS = "re_fallback";
    const { resendKeySource } = await import("@/server/email/resend");
    expect(resendKeySource()).toBe("RESEND_API_KEY");
  });

  it("reports SMTP_PASS when only an re_-prefixed SMTP password is set", async () => {
    serverEnv.SMTP_PASS = "re_from_smtp_pass";
    const { resendKeySource } = await import("@/server/email/resend");
    expect(resendKeySource()).toBe("SMTP_PASS");
  });

  it("reports none when SMTP_PASS is a real password rather than a Resend key", async () => {
    serverEnv.SMTP_PASS = "an-ordinary-smtp-password";
    const { resendKeySource } = await import("@/server/email/resend");
    expect(resendKeySource()).toBe("none");
  });
});

describe("resendKeyProbe — an unverified probe is not a healthy one", () => {
  it("distinguishes a timed-out probe from a working key", async () => {
    // The bug this pins: `unknown` and `ok` both produced an empty warnings
    // array, so a probe that never reached Resend looked exactly like proof
    // that email worked.
    serverEnv.RESEND_API_KEY = "re_k";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("The operation was aborted")),
    );
    const { resendKeyProbe } = await import("@/server/email/resend");
    const probe = await resendKeyProbe();

    expect(probe.status).toBe("unknown");
    expect(probe.httpStatus).toBeNull();
    expect(probe.error).toContain("aborted");
    expect(probe.status).not.toBe("ok");
  });

  it("surfaces the HTTP status Resend actually returned", async () => {
    serverEnv.RESEND_API_KEY = "re_k";
    stubFetch(401, { message: "API key is invalid" });
    const { resendKeyProbe } = await import("@/server/email/resend");
    expect(await resendKeyProbe()).toMatchObject({
      status: "invalid",
      source: "RESEND_API_KEY",
      httpStatus: 401,
    });
  });

  it("treats a non-auth error status as unverified, not as healthy", async () => {
    serverEnv.RESEND_API_KEY = "re_k";
    stubFetch(500, {});
    const { resendKeyProbe } = await import("@/server/email/resend");
    expect(await resendKeyProbe()).toMatchObject({
      status: "unknown",
      httpStatus: 500,
    });
  });

  it("reports unconfigured with source none and makes no request", async () => {
    const fetchMock = stubFetch();
    const { resendKeyProbe } = await import("@/server/email/resend");
    expect(await resendKeyProbe()).toEqual({
      status: "unconfigured",
      source: "none",
      httpStatus: null,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok only on a 2xx", async () => {
    serverEnv.SMTP_PASS = "re_k";
    stubFetch(200, { data: [] });
    const { resendKeyProbe } = await import("@/server/email/resend");
    expect(await resendKeyProbe()).toMatchObject({
      status: "ok",
      source: "SMTP_PASS",
      httpStatus: 200,
    });
  });
});
