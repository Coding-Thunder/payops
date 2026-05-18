"use client";

import * as React from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface ImageUrlPreviewProps {
  url: string | null | undefined;
  /** Pixel size of the thumbnail tile. Defaults to 64 (size-16). */
  size?: number;
  /** Override the helper copy shown next to the thumb. */
  label?: {
    loading?: string;
    ok?: string;
    error?: string;
  };
  /** Hide the helper text — handy in dense forms. */
  hideHelper?: boolean;
}

/**
 * Out-of-band image probe. Loads `url` in an off-DOM `<img>` so we never
 * surface a broken-image icon in the form; falls back to a small "404"
 * pill when the URL doesn't resolve.
 *
 * Only the async LOAD RESULT lives in state. The "loading" state is
 * derived by comparing the stored result's URL with the current URL —
 * when they don't match we know we're still waiting on the new load.
 */
export function ImageUrlPreview({
  url,
  size = 64,
  label,
  hideHelper,
}: ImageUrlPreviewProps) {
  const trimmed = url?.trim() ?? "";
  const isCandidate = trimmed.length > 0 && /^https?:\/\//i.test(trimmed);

  const [loadResult, setLoadResult] = React.useState<
    { url: string; ok: boolean } | null
  >(null);

  React.useEffect(() => {
    if (!isCandidate) return;
    const img = new Image();
    img.onload = () => setLoadResult({ url: trimmed, ok: true });
    img.onerror = () => setLoadResult({ url: trimmed, ok: false });
    img.src = trimmed;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [trimmed, isCandidate]);

  if (!isCandidate) return null;
  const status: "loading" | "ok" | "error" =
    loadResult && loadResult.url === trimmed
      ? loadResult.ok
        ? "ok"
        : "error"
      : "loading";

  return (
    <div className="mt-2 flex items-center gap-3">
      <div
        className={cn(
          "relative grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-surface-1",
          status === "error" && "border-destructive/40",
        )}
        style={{ width: size, height: size }}
      >
        {status === "ok" ? (
          // eslint-disable-next-line @next/next/no-img-element -- the image is
          // user-pasted from the wider web; next/image would proxy it and
          // hide load failures we want to surface here.
          <img
            src={trimmed}
            alt="Preview"
            className="size-full object-cover"
          />
        ) : status === "loading" ? (
          <Spinner size="sm" tone="muted" />
        ) : (
          <span className="text-[10px] font-medium uppercase text-destructive">
            404
          </span>
        )}
      </div>
      {hideHelper ? null : (
        <p className="text-[11.5px] text-muted-foreground">
          {status === "loading"
            ? (label?.loading ?? "Checking image…")
            : status === "ok"
              ? (label?.ok ?? "Image looks good — this is what the customer will see.")
              : (label?.error ??
                "We couldn't load that URL. The customer will see a broken image — paste a different public link.")}
        </p>
      )}
    </div>
  );
}
