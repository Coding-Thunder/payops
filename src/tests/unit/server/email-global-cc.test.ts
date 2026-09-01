/**
 * @vitest-environment node
 *
 * Node, not the project default jsdom: `env.server` deliberately refuses to
 * be read when `window` exists, and the transport factory reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyGlobalCc } from "@/server/email/smtp";

/**
 * The deployment-wide CC.
 *
 * Himanshu's deployment copies every outgoing customer email to a shared
 * support inbox. It is configured (`EMAIL_CC`), not compiled in, so the same
 * code ships to the original deployment and changes nothing there — the first
 * describe block below is what proves that, and it is the important one.
 *
 * The merge lives at the transport rather than in the send helpers because
 * three separate services call `sendMail` directly: the email service, the
 * acknowledgement notification and the quotation sender.
 */

const CC = "support@reservationcarrentals.com";

describe("a deployment with no EMAIL_CC is untouched", () => {
  it("returns the very same object when the address is unset", () => {
    const mail = { to: "guest@example.com", subject: "Payment link" };
    // Identity, not equality: nothing was copied, rewritten or re-keyed.
    expect(applyGlobalCc(mail, undefined)).toBe(mail);
  });

  it("treats an empty or whitespace-only address as unset", () => {
    const mail = { to: "guest@example.com" };
    expect(applyGlobalCc(mail, "")).toBe(mail);
    expect(applyGlobalCc(mail, "   ")).toBe(mail);
  });
});

describe("adding the CC", () => {
  it("adds it to a message that has none", () => {
    expect(applyGlobalCc({ to: "guest@example.com" }, CC)).toEqual({
      to: "guest@example.com",
      cc: [CC],
    });
  });

  it("does not disturb the other fields", () => {
    const out = applyGlobalCc(
      { to: "guest@example.com", from: "b@x.com", subject: "S", html: "<p/>" },
      CC,
    );
    expect(out).toMatchObject({ from: "b@x.com", subject: "S", html: "<p/>" });
  });

  /**
   * CONTRACT CHANGE, and the reason for it.
   *
   * This used to APPEND the deployment address to an existing cc. That was
   * right while one organization existed and nothing ever set `cc` itself.
   *
   * It is wrong on a shared deployment: `sendEmail` now resolves the CC from
   * the organization that owns the ORDER, so an explicit value is a
   * deliberate per-brand decision. Appending the deployment-wide address to
   * it would copy one tenant's support inbox on another tenant's customer
   * mail — two separate legal entities, and a PII leak.
   *
   * An explicit CC is therefore AUTHORITATIVE and passes through untouched.
   */
  it("leaves an explicit cc untouched — it is the caller's decision", () => {
    const out = applyGlobalCc(
      { to: "guest@example.com", cc: "ops@example.com" },
      CC,
    );
    expect(out.cc).toBe("ops@example.com");
  });

  it("does not append the deployment CC to an explicit array cc", () => {
    const out = applyGlobalCc(
      { to: "guest@example.com", cc: ["brand-support@example.com"] },
      CC,
    );
    expect(out.cc).toEqual(["brand-support@example.com"]);
  });

  it("still applies the deployment CC when the caller set an EMPTY cc", () => {
    // An empty string is "no decision made", not "copy nobody" — otherwise a
    // caller that defaults `cc` to "" would silently disable the deployment
    // CC for a single-brand deployment that relies on it.
    const out = applyGlobalCc({ to: "guest@example.com", cc: "" }, CC);
    expect(out.cc).toEqual([CC]);
  });

  it("does not mutate the caller's object", () => {
    const mail = { to: "guest@example.com" };
    applyGlobalCc(mail, CC);
    expect(mail).not.toHaveProperty("cc");
  });
});

describe("nobody is copied twice", () => {
  it("skips the CC when it is already the recipient", () => {
    const mail = { to: CC };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });

  it("skips the CC when it is already CC'd", () => {
    const mail = { to: "guest@example.com", cc: CC };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });

  it("matches case-insensitively, as SMTP does", () => {
    const mail = { to: "SUPPORT@ReservationCarRentals.com" };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });

  it("finds it inside a comma-separated recipient list", () => {
    const mail = { to: `guest@example.com, ${CC}` };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });

  it("finds it inside an array of recipients", () => {
    const mail = { to: ["guest@example.com", CC] };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });
});

describe("recipient shapes it declines to interpret", () => {
  /**
   * Nodemailer also accepts `{ name, address }`. Nothing in this codebase
   * produces one, and rewriting a recipient list we only half-understand is
   * worse than not copying support on that one message.
   */
  it("passes an Address object through untouched", () => {
    const mail = { to: { name: "Guest", address: "guest@example.com" } };
    expect(applyGlobalCc(mail, CC)).toBe(mail);
  });
});

/**
 * The wiring: a message handed to a transport from the factory really does
 * arrive at nodemailer carrying the CC. Proven against a fake transport, so
 * no connection is opened and no mail is sent.
 */
describe("transport wiring", () => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "1" });

  beforeEach(() => {
    vi.resetModules();
    sendMail.mockClear();
    vi.doMock("nodemailer", () => ({
      default: { createTransport: () => ({ sendMail, verify: vi.fn() }) },
    }));
  });

  afterEach(() => {
    vi.doUnmock("nodemailer");
    delete process.env.EMAIL_CC;
  });

  const config = {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "booking@example.com",
    pass: "app password",
  };

  async function freshSmtp() {
    // env.ts memoises its parse, so it has to be re-imported alongside smtp.
    return import("@/server/email/smtp");
  }

  it("carries the CC on a send through the org transport", async () => {
    process.env.EMAIL_CC = CC;
    const { getMailerFor } = await freshSmtp();

    await getMailerFor(config).sendMail({
      to: "guest@example.com",
      subject: "Your payment link",
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "guest@example.com", cc: [CC] }),
    );
  });

  it("sends exactly what it was given when EMAIL_CC is unset", async () => {
    const { getMailerFor } = await freshSmtp();

    await getMailerFor(config).sendMail({ to: "guest@example.com" });

    expect(sendMail).toHaveBeenCalledWith({ to: "guest@example.com" });
  });

  it("still exposes the underlying transport's other methods", async () => {
    process.env.EMAIL_CC = CC;
    const { getMailerFor } = await freshSmtp();
    expect(typeof getMailerFor(config).verify).toBe("function");
  });
});
