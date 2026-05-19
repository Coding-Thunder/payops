import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Card — refined for "professionally designed" SaaS feel.
 *
 *   - Default tone: clean white with a soft hairline border. NO
 *     drop-shadow by default (shadows on every card is the #1 AI-
 *     template tell). Use `tone="raised"` when a card genuinely
 *     earns elevation (one per screen, not on every grid tile).
 *   - Asymmetric padding rhythm: header is tighter (pulls the title
 *     close to the content), content gets generous bottom space.
 *     Beats the "perfectly uniform inset" pattern.
 *   - Radius uses the panel scale (12px) instead of `rounded-lg`
 *     blanket — readable as a card, not a chip.
 *   - `accent` prop paints a hairline gradient stroke at the top
 *     edge for "important" surfaces. Use sparingly.
 */
type CardAccent = "orange" | "sage" | "cobalt" | "ultraviolet" | "cream";

function accentToVar(accent: CardAccent): string {
  return {
    orange: "var(--m-orange)",
    sage: "var(--m-sage)",
    cobalt: "var(--m-cobalt)",
    ultraviolet: "var(--m-ultraviolet)",
    cream: "var(--m-cream-accent)",
  }[accent];
}

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "muted" | "ghost" | "raised";
  accent?: CardAccent;
}

function Card({
  className,
  tone = "default",
  accent,
  style,
  ...props
}: CardProps) {
  return (
    <div
      data-slot="card"
      style={{ borderRadius: "var(--radius-card)", ...style }}
      className={cn(
        "relative text-card-foreground",
        tone === "default" && "bg-card border border-border",
        tone === "muted" && "bg-surface-1 border border-border",
        tone === "ghost" && "bg-transparent",
        tone === "raised" &&
          "bg-card border border-border shadow-sm",
        accent && "overflow-hidden",
        className,
      )}
      {...props}
    >
      {accent ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${accentToVar(accent)} 50%, transparent 100%)`,
          }}
        />
      ) : null}
      {props.children}
    </div>
  );
}

function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        // Tighter top, looser bottom — pulls the title block close
        // to the divider-free transition into content.
        "flex flex-col gap-1.5 px-5 pt-5 pb-3 sm:px-6 sm:pt-5 sm:pb-3.5",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      data-slot="card-title"
      className={cn(
        // Weight + size + tighter tracking so the title clearly
        // out-weights the description below. `leading-none` was the
        // tell — replaced with `leading-[1.25]` so multi-line titles
        // breathe without falling apart.
        "text-[14.5px] font-semibold leading-[1.25] tracking-[-0.014em]",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      data-slot="card-description"
      className={cn(
        // Looser line-height for genuine readability at small sizes.
        "text-[12.5px] leading-[1.55] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardAction({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-5 pb-5 sm:px-6 sm:pb-6", className)}
      {...props}
    />
  );
}

function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        // Top-divider footer pattern — clearly partitions actions
        // from content without resorting to a colored band.
        "flex items-center gap-2 border-t border-border px-5 py-3.5 sm:px-6 sm:py-4",
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
};
