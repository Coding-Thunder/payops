import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Card — Stripe-style flat surface. By default: white background, soft
 * border, no shadow. Use the `tone` prop to switch to a subtle inset
 * surface for sub-sections.
 */
function Card({
  className,
  tone = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  tone?: "default" | "muted" | "ghost";
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-lg text-card-foreground",
        tone === "default" && "bg-card border border-border",
        tone === "muted" && "bg-surface-1 border border-border",
        tone === "ghost" && "bg-transparent",
        className,
      )}
      {...props}
    />
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
        "flex flex-col gap-1 px-5 pt-5 pb-3 sm:px-6 sm:pt-6 sm:pb-4",
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
        "text-[14px] font-semibold leading-none tracking-tight",
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
      className={cn("text-[12.5px] text-muted-foreground leading-relaxed", className)}
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
        "flex items-center px-5 pb-5 sm:px-6 sm:pb-6 pt-0",
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
