/**
 * SMTP / Resend diagnostic. Loads SMTP_* + EMAIL_FROM* from the environment,
 * verifies the connection + auth, then attempts one real send — printing the
 * provider's exact response so a silent "email not arriving" becomes an
 * actionable error (bad key, unverified domain, test-mode recipient limit…).
 *
 * Usage:
 *   tsx --env-file=admin/.env.prod scripts/mail-doctor.ts [recipient]
 *   tsx --env-file=.env.prod       scripts/mail-doctor.ts [recipient]
 */

import nodemailer from "nodemailer";

async function main(): Promise<void> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE ?? "true") === "true";
  const user = process.env.SMTP_USER;
  const pass = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const from =
    process.env.EMAIL_FROM_ACCOUNTS || process.env.EMAIL_FROM || "";
  const to = process.argv[2] || "vinaymaheshwari35@gmail.com";

  console.log("SMTP config:", {
    host,
    port,
    secure,
    user,
    from,
    to,
    passPresent: pass.length > 0,
    passLen: pass.length,
  });
  if (!host || !user || !pass) {
    console.error("✗ Missing SMTP_HOST / SMTP_USER / SMTP_PASS in this env.");
    process.exit(1);
  }

  const t = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  });

  try {
    await t.verify();
    console.log("✓ verify() OK — connection + auth accepted by the relay.");
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
    console.error("✗ verify() FAILED:", {
      code: err.code,
      responseCode: err.responseCode,
      response: err.response ?? err.message,
    });
    process.exit(1);
  }

  try {
    const info = await t.sendMail({
      from,
      to,
      subject: "TraceTxn mail-doctor test",
      text: "If you received this, TraceTxn SMTP delivery is working.",
      headers: { "X-Entity-Kind": "MAIL_DOCTOR" },
    });
    console.log("✓ sendMail OK:", {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; command?: string; response?: string; message?: string };
    console.error("✗ sendMail FAILED:", {
      code: err.code,
      responseCode: err.responseCode,
      command: err.command,
      response: err.response ?? err.message,
    });
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("mail-doctor error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
