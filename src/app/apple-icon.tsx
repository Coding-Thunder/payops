import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon — rendered to PNG at build/request time via
 * ImageResponse so iOS home-screen pins get the proper rounded-square
 * format (Safari doesn't render SVG apple-touch-icons).
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          borderRadius: 40,
          background: "#0A0A0A",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <svg
          viewBox="0 0 180 180"
          width={180}
          height={180}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M54 46h42c18.5 0 32.5 12.6 32.5 31s-14 31-32.5 31H74v37H54V46zm20 45h21c8.5 0 14-5.5 14-14s-5.5-14-14-14H74v28z"
            fill="#FFFFFF"
          />
          <rect x="106" y="124" width="28" height="8" rx="4" fill="#22C55E" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
