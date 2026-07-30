"use client";

/**
 * Last-resort boundary for a throw in the ROOT layout itself (where the normal
 * `error.tsx` can't help — it lives inside that layout). It REPLACES the root
 * layout, so it must render its own <html>/<body> and can't rely on the app's
 * CSS being loaded — hence the inline styles and a single deliberate dark
 * fallback ground. This should almost never render; it exists so the very
 * worst case is still a branded "try again" rather than a blank crash.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "24px",
          background: "#0b0f19",
          color: "#e9edf6",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: "420px", textAlign: "center" }}>
          <h1 style={{ fontSize: "18px", fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.6,
              opacity: 0.72,
              marginTop: "8px",
            }}
          >
            The app hit an unexpected error. Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "20px",
              padding: "9px 20px",
              borderRadius: "8px",
              border: "1px solid #2b3852",
              background: "#6d86ff",
              color: "#0b0f19",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "11px",
                opacity: 0.5,
                marginTop: "18px",
              }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
