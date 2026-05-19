"use client";

import Script from "next/script";
import { useEffect, useId, useRef } from "react";

/**
 * Lightweight wrapper around Cloudflare Turnstile.
 *
 * The widget renders an invisible iframe and (when needed) a managed
 * challenge; on solve it pushes the verification token through the
 * `onVerify` callback. The form is expected to ship the token to the
 * server under a `cfToken` field, which the route then re-verifies
 * against challenges.cloudflare.com via the `verifyTurnstile` helper.
 *
 * Renders nothing when `siteKey` is empty so the existing form keeps
 * working in environments that haven't configured Turnstile yet.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          theme?: "light" | "dark" | "auto";
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          appearance?: "always" | "execute" | "interaction-only";
          retry?: "auto" | "never";
          "retry-interval"?: number;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  /** Public Cloudflare site key. When empty the component renders null. */
  siteKey: string | null | undefined;
  /** Called with the Turnstile token once the user is verified. */
  onVerify: (token: string) => void;
  /** Called when the user's token expires (rare; happens after ~5 min). */
  onExpire?: () => void;
  /** Called on a Turnstile-side error (network, ratelimit). */
  onError?: () => void;
  /** Light / dark — falls back to "auto" matching system preference. */
  theme?: "light" | "dark" | "auto";
  /** Cosmetic className for the wrapper div. */
  className?: string;
}

export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  onError,
  theme = "auto",
  className,
}: TurnstileWidgetProps) {
  const wrapperId = useId();
  const widgetId = useRef<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Latest callback refs so the render() call doesn't need to be torn
  // down + re-attached when the parent re-renders.
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    let pollHandle: number | null = null;

    const mount = () => {
      if (cancelled) return;
      if (!window.turnstile || !wrapperRef.current) {
        pollHandle = window.setTimeout(mount, 100);
        return;
      }
      if (widgetId.current) return; // already mounted
      widgetId.current = window.turnstile.render(wrapperRef.current, {
        sitekey: siteKey,
        theme,
        appearance: "interaction-only",
        callback: (token) => onVerifyRef.current(token),
        "expired-callback": () => onExpireRef.current?.(),
        "error-callback": () => onErrorRef.current?.(),
      });
    };

    mount();

    return () => {
      cancelled = true;
      if (pollHandle) window.clearTimeout(pollHandle);
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          // Already torn down — Turnstile sometimes throws on double-remove.
        }
        widgetId.current = null;
      }
    };
  }, [siteKey, theme]);

  if (!siteKey) return null;

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
        async
        defer
      />
      <div
        id={`turnstile-${wrapperId}`}
        ref={wrapperRef}
        className={className}
      />
    </>
  );
}
