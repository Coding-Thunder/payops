import { cookies } from "next/headers";

import { env } from "@/lib/env";
import { getSessionTtlSeconds } from "./jwt";

interface SetSessionOptions {
  maxAgeSeconds?: number;
}

export async function setSessionCookie(
  token: string,
  options: SetSessionOptions = {},
) {
  const { COOKIE_NAME, COOKIE_DOMAIN, COOKIE_SECURE, NODE_ENV } = env.server;
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    // SameSite=strict pairs with the `withApi` Origin check as the CSRF
    // defense. PayOps has no cross-site auth requirement; agents
    // browse from bookmarks / internal nav. Customer-facing pages
    // (`/pay/*`, `/consent/*`) don't read this cookie at all.
    sameSite: "strict",
    secure: COOKIE_SECURE || NODE_ENV === "production",
    path: "/",
    domain: COOKIE_DOMAIN || undefined,
    maxAge: options.maxAgeSeconds ?? getSessionTtlSeconds(),
  });
}

export async function clearSessionCookie() {
  const { COOKIE_NAME, COOKIE_DOMAIN, COOKIE_SECURE, NODE_ENV } = env.server;
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: COOKIE_SECURE || NODE_ENV === "production",
    path: "/",
    domain: COOKIE_DOMAIN || undefined,
    maxAge: 0,
  });
}

export async function readSessionCookie(): Promise<string | null> {
  const { COOKIE_NAME } = env.server;
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}
