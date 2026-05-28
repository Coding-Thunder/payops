import { z } from "zod";

const isServer = typeof window === "undefined";

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().min(1).default("TraceTxn"),
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
  EMAIL_FROM: z
    .string()
    .default("TraceTxn <no-reply@tracetxn.example.com>"),
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

  /**
   * AES-256 master key (32 bytes, base64-encoded) used to encrypt
   * per-org gateway credentials at rest. Optional during the
   * multi-tenant migration window — the legacy tenant continues to
   * use env-based Stripe credentials and never touches this. Required
   * the moment ANY org saves a per-org gateway credential.
   *
   * Generate: `openssl rand -base64 32`
   *
   * Treat as a high-value secret. Loss of the key locks all encrypted
   * credentials. Rotation: write new rows with the new key (the field
   * `keyVersion` on each encrypted blob discriminates which key to
   * use at decrypt time), then re-encrypt old rows and drop the
   * previous key — manage out-of-band.
   */
  TRACETXN_MASTER_KEY: z
    .string()
    .optional()
    .refine(
      (v) => !v || Buffer.from(v, "base64").length === 32,
      "TRACETXN_MASTER_KEY must decode to exactly 32 bytes (base64). Generate one with: openssl rand -base64 32",
    ),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default("TraceTxn"),
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
