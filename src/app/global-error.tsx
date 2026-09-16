"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary, for a failure in the root layout itself.
 *
 * This one replaces the entire document, so it must render its own <html>
 * and <body> — the layout that would normally provide them is precisely what
 * failed. For the same reason it carries inline styles rather than the app's
 * classes: the stylesheet the root layout loads may never have been applied.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[payops] root layout error", {
      digest: error.digest,
      name: error.name,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#fafafa",
          color: "#0b1220",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 12px" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#52525b", margin: 0 }}>
            The application failed to load. The problem has been recorded.
          </p>
          {error.digest ? (
            <p
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
                color: "#71717a",
                marginTop: 12,
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              color: "#fafafa",
              background: "#0b1220",
              border: 0,
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
