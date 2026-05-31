import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon — rendered to PNG at build/request time via
 * ImageResponse so iOS home-screen pins get the proper rounded-square
 * format (Safari doesn't render SVG apple-touch-icons).
 *
 * Brand-v1: navy rounded-square tile + the four-node trace mark in
 * white, with the emerald accent on the settlement node. Scaled to
 * the 180×180 canvas: original mark is 40×40 → scale 4.5×.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          borderRadius: 40,
          background: "#0F172A",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          viewBox="0 0 40 40"
          width={120}
          height={120}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M6 14L16 14L24 20L34 14"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="square"
            strokeLinejoin="miter"
            fill="none"
          />
          <path
            d="M16 14V24"
            stroke="#10B981"
            strokeWidth="2"
            strokeLinecap="square"
          />
          <circle cx="6" cy="14" r="3" fill="#FFFFFF" />
          <circle cx="16" cy="14" r="3" fill="#FFFFFF" />
          <circle cx="24" cy="20" r="3" fill="#10B981" />
          <circle cx="34" cy="14" r="3" fill="#FFFFFF" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
