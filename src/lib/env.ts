import { z } from "zod";

const isServer = typeof window === "undefined";

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().min(1).default("PayOps"),
  CUSTOMER_BRAND_NAME: z.string().min(1).default("Rental Confirmation"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().optional(),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 chars"),
  /** Hard ceiling on session lifetime is enforced separately in the JWT
   *  helper (7d). Keep this string parseable as `<num><s|m|h|d>`. */
  JWT_EXPIRES_IN: z.string().default("12h"),
  /** Optional. Defaults to JWT_SECRET when unset so existing deploys
   *  keep working, but encouraged to rotate to a dedicated secret so a
   *  leak of session material doesn't also forge consent tokens. */
  CONSENT_TOKEN_SECRET: z.string().min(32).optional(),
  /**
   * Master key for the per-organization credential vault
   * (`@/lib/crypto/secret-box`). 32 bytes, base64 or hex.
   *
   * INTENTIONALLY OPTIONAL. `parseServer()` throws on any validation
   * failure and runs on the first `env.server` read in the request path, so
   * marking this required would take down every deployment that has not set
   * it yet — including production, on the deploy that introduced it. The
   * vault therefore fails at the point of use ("credential vault is not
   * configured") rather than at boot, and organizations with no stored
   * credentials keep falling back to the deployment-level values.
   *
   * Generate with:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  CREDENTIALS_MASTER_KEY: z.string().optional(),
  /** Rotation counter for CREDENTIALS_MASTER_KEY. New secrets are sealed
   *  under this version; older rows keep opening under the version stamped
   *  on them. */
  CREDENTIALS_KEY_VERSION: z.coerce.number().int().positive().default(1),

  COOKIE_NAME: z.string().default("payops_session"),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    // Default true so a missing env in prod can't ship Secure-less
    // cookies. Local dev that uses plain HTTP can set COOKIE_SECURE=false
    // explicitly.
    .default(true),

  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(1, "STRIPE_WEBHOOK_SECRET is required"),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  // ---- SMTP (Google Workspace + App Password) ----
  // Leave SMTP_HOST empty to disable email sending (failed sends become
  // EMAIL_FAILED audit rows; nothing else breaks).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /**
   * Address copied on EVERY outgoing email from this deployment.
   *
   * Optional, and its absence is the default: a deployment that does not set
   * it sends exactly what it sent before. That is what keeps this safe to
   * carry in shared code — the behaviour is chosen by configuration, not by
   * which branch is deployed.
   */
  EMAIL_CC: z.string().optional(),
  EMAIL_FROM: z
    .string()
    .default("PayOps <no-reply@payops.example.com>"),
  EMAIL_REPLY_TO: z.string().optional(),
  SUPPORT_EMAIL: z.string().default("vinaymaheshwari35@gmail.com"),
  SUPPORT_PHONE: z.string().default("+1-555-0100"),

  DEFAULT_CURRENCY: z.string().default("USD"),
  DEFAULT_PAYMENT_EXPIRY_HOURS: z.coerce.number().int().positive().default(24),
  DEFAULT_ORDER_PREFIX: z.string().default("ORD"),

  /**
   * Cloudflare Turnstile — server-side secret used to verify client
   * tokens against challenges.cloudflare.com. Leave empty to disable
   * the bot-check pre-flight on /api/auth/login and /api/quotations:
   * routes still serve, the verifier just no-ops. Pair with the public
   * NEXT_PUBLIC_TURNSTILE_SITE_KEY below — both must be set for the
   * widget to render AND the server to validate.
   */
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default("PayOps"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Cloudflare Turnstile public site key. When set, the login + sales
   *  forms render the Turnstile widget and pass its token through to
   *  the API. Server verification lives behind TURNSTILE_SECRET_KEY. */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

let cachedServer: ServerEnv | null = null;
let cachedClient: ClientEnv | null = null;

function parseServer(): ServerEnv {
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => ` - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment variables:\n${formatted}`);
  }
  cachedServer = parsed.data;
  return parsed.data;
}

function parseClient(): ClientEnv {
  if (cachedClient) return cachedClient;
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  });
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => ` - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid public environment variables:\n${formatted}`);
  }
  cachedClient = parsed.data;
  return parsed.data;
}

/**
 * Strongly-typed env accessor. Reading `env.server.X` from a client bundle
 * will throw - keep it on the server.
 */
export const env = {
  get server(): ServerEnv {
    if (!isServer) {
      throw new Error("Server env cannot be read from the browser bundle");
    }
    return parseServer();
  },
  get public(): ClientEnv {
    return parseClient();
  },
};
