import "server-only";

import Stripe from "stripe";

import { env } from "@/lib/env";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  cached = new Stripe(env.server.STRIPE_SECRET_KEY, {
    typescript: true,
    appInfo: { name: "PayOps", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  return cached;
}
