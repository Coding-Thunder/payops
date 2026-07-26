import "server-only";

import { z } from "zod";

/**
 * Admin-console environment. Server secrets are validated lazily on first
 * access so a missing var throws a clear error at request time rather than
 * a cryptic undefined deep in a query.
 */
const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_NAME: z.string().default("TraceTxn Admin"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().optional(),

  // Shared with the main app so minted set-password links validate there.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  // Dedicated admin-session signing key; falls back to JWT_SECRET.
  ADMIN_SESSION_SECRET: z.string().optional(),

  ADMIN_ALLOWLIST: z.string().default("vinaymaheshwari35@gmail.com"),

  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(72).default(8),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().max(60).default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  MAIN_APP_URL: z.string().url().default("http://localhost:3000"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM_ACCOUNTS: z
    .string()
    .default("TraceTxn Accounts <accounts@tracetxn.com>"),
  EMAIL_REPLY_TO: z.string().optional(),

  COOKIE_SECURE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .default(true),
  COOKIE_DOMAIN: z.string().optional(),

  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
});

const clientSchema = z.object({
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

function parseServer(): ServerEnv {
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => ` - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid admin environment variables:\n${formatted}`);
  }
  cachedServer = parsed.data;
  return parsed.data;
}

/**
 * Public (browser-safe) Firebase config. Next.js inlines
 * `NEXT_PUBLIC_*` at build time, so this reads them individually.
 */
export const publicEnv: ClientEnv = clientSchema.parse({
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
});

export const env = {
  get server(): ServerEnv {
    return parseServer();
  },
};
