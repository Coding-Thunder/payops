import { z } from "zod";

const isServer = typeof window === "undefined";

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().min(1).default("PayOps Rentals"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().optional(),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  COOKIE_NAME: z.string().default("payops_session"),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),

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
    .default("PayOps Rentals <no-reply@payops.example.com>"),
  EMAIL_REPLY_TO: z.string().optional(),
  SUPPORT_EMAIL: z.string().default("support@payops.example.com"),
  SUPPORT_PHONE: z.string().default("+1-555-0100"),

  DEFAULT_CURRENCY: z.string().default("USD"),
  DEFAULT_PAYMENT_EXPIRY_HOURS: z.coerce.number().int().positive().default(24),
  DEFAULT_ORDER_PREFIX: z.string().default("ORD"),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default("PayOps Rentals"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
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
