import { ImageResponse } from "next/og";

/**
 * Dynamic Open Graph image for the marketing landing.
 *
 * Auto-served by Next 16 at `/opengraph-image` and referenced
 * automatically in <meta property="og:image"> — overrides any
 * static OG image set in the root metadata. Same image is used by
 * Twitter (summary_large_image card).
 *
 * Why dynamic over a static PNG:
 *   - It renders with the actual brand obsidian + gradient palette,
 *     so the card matches what a visitor sees when they click.
 *   - Copy stays in code — if positioning shifts, this updates in
 *     the next deploy with no Photoshop loop.
 *   - 1200×630 is the canonical OG size (Slack / LinkedIn / Twitter
 *     all crop to this).
 *
 * Edge-runtime + system-font default (Inter on most platforms) so
 * cold-start time is sub-100ms.
 */

export const runtime = "edge";
export const alt =
  "PayOps — When the chargeback lands six weeks later, the evidence is already filed.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0A0A0A",
          display: "flex",
          flexDirection: "column",
          padding: "72px 80px",
          position: "relative",
          overflow: "hidden",
          fontFamily: "system-ui, sans-serif",
          color: "white",
        }}
      >
        {/* Aurora orbs — match the hero's color signature */}
        <div
          style={{
            position: "absolute",
            top: -120,
            left: -140,
            width: 540,
            height: 540,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,131,60,0.45) 0%, transparent 65%)",
            filter: "blur(20px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -120,
            right: -140,
            width: 580,
            height: 580,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(150,90,240,0.45) 0%, transparent 65%)",
            filter: "blur(20px)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 200,
            left: "40%",
            width: 380,
            height: 380,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(64,120,255,0.32) 0%, transparent 65%)",
            filter: "blur(24px)",
          }}
        />

        {/* Top chromatic stroke — same gradient as the in-app telemetry strip */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background:
              "linear-gradient(90deg, transparent 0%, rgba(255,131,60,0.9) 25%, rgba(64,120,255,0.9) 55%, rgba(150,90,240,0.9) 80%, transparent 100%)",
          }}
        />

        {/* Brand block — top-left */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            zIndex: 2,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: "white",
              color: "#0A0A0A",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 26,
              letterSpacing: -1,
            }}
          >
            P
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.5,
              color: "white",
            }}
          >
            PayOps
          </div>
          <div
            style={{
              marginLeft: 14,
              fontSize: 13,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.5)",
              fontWeight: 500,
            }}
          >
            · payment operations
          </div>
        </div>

        {/* Headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 64,
            zIndex: 2,
          }}
        >
          <div
            style={{
              fontSize: 76,
              fontWeight: 600,
              lineHeight: 1.04,
              letterSpacing: -2.4,
              color: "white",
              maxWidth: 1020,
            }}
          >
            When the chargeback{" "}
            <span
              style={{
                backgroundImage:
                  "linear-gradient(95deg, rgba(255,131,60,1) 0%, rgba(255,180,120,1) 50%, rgba(150,90,240,1) 100%)",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              lands six weeks later
            </span>
            , the evidence is already filed.
          </div>
        </div>

        {/* Sub-line — privately deployed signal */}
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            zIndex: 2,
            fontSize: 18,
            color: "rgba(255,255,255,0.7)",
            fontWeight: 500,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "rgb(80,210,130)",
              }}
            />
            Privately deployed · reserved per merchant
          </div>
          <div
            style={{
              fontSize: 16,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.45)",
            }}
          >
            Stripe live · Razorpay · Adyen
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
