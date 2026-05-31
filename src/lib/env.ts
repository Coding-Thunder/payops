import { z } from "zod";

const isServer = typeof window === "undefined";

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().min(1).default("TraceTxn"),
  /**
   * Deprecated. Was the platform-wide customer brand name baked into
   * every tenant's emails before the multi-tenant branding fix.
   * Empty default now — per-org Branding.brandName is the source of
   * truth. Kept on the schema only for the legacy singleton path
   * (no-orgId fallback) used during the multi-tenant migration window.
   */
  CUSTOMER_BRAND_NAME: z.string().default(""),
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
  COOKIE_NAME: z.string().default("tracetxn_session"),
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
  // Note: server-side STRIPE_PUBLISHABLE_KEY is intentionally not in
  // the schema — the publishable key only matters to the browser and
  // is sourced from NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY below.

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
  /**
   * Deprecated platform-wide support contacts. Empty defaults — each
   * tenant's Branding.supportEmail / supportPhone is the source of
   * truth. Only used by the legacy-singleton fallback in
   * branding.service.platformFallback (no-orgId path) and by
   * quotation.service for marketing-form replies. New tenants never
   * inherit these.
   */
  SUPPORT_EMAIL: z.string().default(""),
  SUPPORT_PHONE: z.string().default(""),

  // Seed defaults for the per-org Setting document. Per-tenant edits
  // in /admin/settings override these; they only matter at the moment
  // a new tenant's settings row is created.
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

  /**
   * Firebase Admin SDK service-account JSON, inlined as a single-line
   * string. Required for the /api/auth/firebase-session route to verify
   * ID tokens against the Firebase project. Generate from GCP Console →
   * IAM → Service Accounts → Keys, then paste the entire JSON wrapped
   * in single quotes:
   *   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"…",…}'
   *
   * Optional — when unset, the Firebase auth route returns 503 and the
   * UI falls back to the legacy bcrypt sign-in path (which keeps working).
   */
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default("TraceTxn"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Cloudflare Turnstile public site key. When set, the login + sales
   *  forms render the Turnstile widget and pass its token through to
   *  the API. Server verification lives behind TURNSTILE_SECRET_KEY. */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),

  /** Firebase Web SDK config — public values, safe to ship to the
   *  browser. All five must be set together; if any is missing the
   *  Firebase auth UI falls back to "feature unavailable" and the
   *  legacy bcrypt sign-in form is shown instead. */
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().optional(),
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
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID:
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
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
