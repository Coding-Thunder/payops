"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { UploadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface LogoPickerRowProps {
  /** Newly-picked file (not yet uploaded). When present, takes visual
   *  precedence over `currentLogoSrc` so the admin sees what they're
   *  about to commit. */
  file: File | null;
  /** Currently-saved logo URL/path. Falls back to a generic mark if empty. */
  currentLogoSrc: string;
  /** Alt text / accessible label for the preview chip. */
  altText: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (file: File | null) => void;
  /** Right-side hint text. Defaults to the standard upload constraints. */
  hint?: string;
  /** Visual width/height of the preview chip in px. */
  size?: number;
  className?: string;
}

/**
 * Shared "preview + upload" row used by provider + branding forms. The
 * server-side validation rules are identical for both — keep them in sync
 * with `provider.service` / `branding.service` upload constraints.
 */
export function LogoPickerRow({
  file,
  currentLogoSrc,
  altText,
  fileInputRef,
  onPick,
  hint = "PNG, JPEG, WebP, GIF, or SVG · up to 512KB.",
  size = 56,
  className,
}: LogoPickerRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-lg border border-border bg-surface-1 p-3",
        className,
      )}
    >
      {file ? (
        <LogoFilePreview file={file} size={size} />
      ) : (
        <CurrentLogoPreview src={currentLogoSrc} alt={altText} size={size} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">Brand mark</p>
        <p className="text-[11.5px] text-muted-foreground">{hint}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
      >
        <UploadIcon className="size-3.5" />
        {file ? "Replace" : "Upload"}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function LogoFilePreview({ file, size }: { file: File; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => setSrc(reader.result as string);
    reader.readAsDataURL(file);
    return () => reader.abort();
  }, [file]);
  if (!src) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/10"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="size-full object-contain" />
    </span>
  );
}

function CurrentLogoPreview({
  src,
  alt,
  size,
}: {
  src: string;
  alt: string;
  size: number;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/10 text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {src ? (
        <Image
          src={src}
          alt={alt}
          width={size}
          height={size}
          unoptimized
          className="size-full object-contain"
        />
      ) : (
        <span className="text-[10px] uppercase tracking-wider">No logo</span>
      )}
    </span>
  );
}

interface ColorInputProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

/** Native color picker + hex text field, normalising to uppercase hex. */
export function ColorInput({ value, onChange, disabled }: ColorInputProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="h-9 w-12 cursor-pointer rounded border border-input bg-background disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="font-mono uppercase"
      />
    </div>
  );
}
