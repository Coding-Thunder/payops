import "server-only";

import { Resend } from "resend";

import { env } from "@/lib/env";

let cached: Resend | null = null;

export function getResend(): Resend | null {
  const key = env.server.RESEND_API_KEY;
  if (!key) return null;
  if (cached) return cached;
  cached = new Resend(key);
  return cached;
}
