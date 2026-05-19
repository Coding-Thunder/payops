import Image, { type StaticImageData } from "next/image";

import { cn } from "@/lib/utils";

interface ScreenshotFrameProps {
  src: string | StaticImageData;
  alt: string;
  /** Hint shown in the fake URL bar — e.g. "payops.example.com / dashboard". */
  urlLabel?: string;
  /** Pinned width/height of the source image so Next/Image can lay out
   *  without CLS. Captured shots are 1440×900. */
  width?: number;
  height?: number;
  className?: string;
  /** Hide the chrome bar — used when the screenshot itself includes
   *  enough product context to stand alone (rare). */
  bare?: boolean;
  /** `priority` on the LCP screenshot only (typically the hero). */
  priority?: boolean;
}

/**
 * Frames an authed-app screenshot inside a subtle browser-chrome
 * wrapper so the landing page reads as "real product", not "naked PNG".
 * The chrome is intentionally light — minimal traffic lights + URL pill
 * — so the screenshot itself stays the focal point.
 */
export function ScreenshotFrame({
  src,
  alt,
  urlLabel,
  width = 1440,
  height = 900,
  className,
  bare = true,
  priority,
}: ScreenshotFrameProps) {
  return (
    <figure
      className={cn(
        "overflow-hidden rounded-2xl bg-surface-0 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.55)]",
        className,
      )}
    >
      {!bare ? <ChromeBar urlLabel={urlLabel} /> : null}
      <div className="relative">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          priority={priority}
          sizes="(min-width: 1280px) 1100px, (min-width: 768px) 80vw, 100vw"
          className="block h-auto w-full"
        />
      </div>
    </figure>
  );
}

function ChromeBar({ urlLabel }: { urlLabel?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
      </div>
      {urlLabel ? (
        <div className="mx-auto inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          <LockIcon /> {urlLabel}
        </div>
      ) : null}
      <span className="w-14" />
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 12 12" className="size-3" fill="none" aria-hidden>
      <rect
        x="2"
        y="5"
        width="8"
        height="6"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M4 5V3.5a2 2 0 014 0V5"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}
