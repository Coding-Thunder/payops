/**
 * Minimal structured logger. Never log secrets - this helper redacts known
 * sensitive keys before emitting.
 */

type Level = "debug" | "info" | "warn" | "error";

const REDACTED = "[redacted]";
const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "jwt",
  "secret",
  "authorization",
  "cookie",
  "set-cookie",
  "stripe_secret_key",
  "smtp_pass",
  "jwt_secret",
]);

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitize(v, seen);
    }
  }
  return out;
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: sanitize(context) } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
     
    console.error(line);
  } else if (level === "warn") {
     
    console.warn(line);
  } else {
     
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) =>
    process.env.NODE_ENV !== "production" && emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    emit("error", msg, ctx),
};
