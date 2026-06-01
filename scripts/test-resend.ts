
/**
 * Send a real test email through Resend so you can verify the SMTP
 * wiring + DKIM alignment + deliverability before any customer
 * triggers a live flow.
 *
 * Run:
 *   npx tsx --require ./scripts/shim-server-only.cjs \
 *     scripts/test-resend.ts --to=you@example.com [--template=welcome]
 *
 * Templates:
 *   welcome        (default) Account welcome email
 *   trial-ending   Trial-ending-soon heads-up (3 days remaining)
 *   all            Fire every template back-to-back
 *
 * Reads SMTP_* + EMAIL_FROM_ACCOUNTS from the active env. Failures
 * surface inline so you can debug DKIM / SPF / API-key issues
 * without digging through audit rows.
 */

import mongoose from "mongoose";

import { connectMongo } from "@/server/db/mongoose";
import {
  sendTrialEndingSoonEmail,
  sendWelcomeEmail,
} from "@/server/services/email.service";

interface Args {
  to: string;
  template: "welcome" | "trial-ending" | "all";
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let to = "";
  let template: Args["template"] = "welcome";

  for (const arg of argv) {
    if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length).trim();
    } else if (arg.startsWith("--template=")) {
      const t = arg.slice("--template=".length).trim();
      if (t === "welcome" || t === "trial-ending" || t === "all") {
        template = t;
      } else {
        console.error(`Unknown template: ${t}`);
        process.exit(2);
      }
    }
  }

  if (!to || !/^.+@.+\..+$/.test(to)) {
    console.error(
      "usage: scripts/test-resend.ts --to=<email> [--template=welcome|trial-ending|all]",
    );
    process.exit(2);
  }
  return { to, template };
}

async function run(): Promise<void> {
  const args = parseArgs();
  await connectMongo();

  console.log(`Sending '${args.template}' to ${args.to}...`);

  if (args.template === "welcome" || args.template === "all") {
    const result = await sendWelcomeEmail({
      to: args.to,
      customerName: "Test User",
      workspaceName: "Test Workspace",
    });
    console.log(`  welcome      → messageId=${result.id ?? "(none, SMTP disabled?)"}`);
  }

  if (args.template === "trial-ending" || args.template === "all") {
    const result = await sendTrialEndingSoonEmail({
      to: args.to,
      customerName: "Test User",
      workspaceName: "Test Workspace",
      daysRemaining: 3,
    });
    console.log(`  trial-ending → messageId=${result.id ?? "(none, SMTP disabled?)"}`);
  }

  console.log("");
  console.log("Done. Check Resend dashboard → Logs for the delivery event.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
