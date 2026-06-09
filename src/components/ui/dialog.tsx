"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Dialog, Stripe / Linear quality:
 *  - barely-there backdrop (8% dim + 6px blur, animated 180ms)
 *  - soft 12px radius surface, hairline border, refined shadow-lg
 *  - size variants (sm / md / lg) so primitives stay consistent across
 *    confirm dialogs, form dialogs, and detail dialogs
 *  - dedicated Header / Body / Footer slots with disciplined padding
 *  - optional icon slot in the header for semantic dialogs (destructive,
 *    warning, info)
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-foreground/[0.08] backdrop-blur-[3px]",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      "data-[state=open]:duration-180 data-[state=closed]:duration-120",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const dialogContentVariants = cva(
  cn(
    "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
    "w-[calc(100vw-1.5rem)]",
    "flex flex-col overflow-hidden",
    "rounded-xl border border-border bg-card shadow-lg",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
    "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-[0.98]",
    "data-[state=closed]:slide-out-to-top-[1%] data-[state=open]:slide-in-from-top-[1%]",
    "data-[state=open]:duration-200 data-[state=closed]:duration-140",
    "ease-out",
  ),
  {
    variants: {
      size: {
        sm: "max-w-[420px]",
        md: "max-w-[480px]",
        lg: "max-w-[640px]",
        xl: "max-w-[760px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof dialogContentVariants> {
  showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    { className, children, showCloseButton = true, size, ...props },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            className={cn(
              "absolute right-3 top-3 grid size-7 place-items-center rounded-md",
              "text-muted-foreground/80 hover:text-foreground hover:bg-muted",
              "transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none",
            )}
          >
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

/* ───────────────────────── Header / Body / Footer ──────────────────────── */

const headerToneStyles: Record<DialogHeaderTone, string> = {
  default: "bg-primary/10 text-primary ring-primary/15",
  destructive: "bg-destructive-soft text-destructive ring-destructive-border/60",
  warning: "bg-warning-soft text-warning-foreground ring-warning-border/60",
  success: "bg-success-soft text-success ring-success-border/60",
  info: "bg-info-soft text-info ring-info-border/60",
};

export type DialogHeaderTone =
  | "default"
  | "destructive"
  | "warning"
  | "success"
  | "info";

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional icon node rendered in a tinted square to the left of the title. */
  icon?: React.ReactNode;
  tone?: DialogHeaderTone;
}

const DialogHeader = ({
  className,
  icon,
  tone = "default",
  children,
  ...props
}: DialogHeaderProps) => (
  <div
    className={cn(
      "flex items-start gap-3 px-5 pt-5 pb-4 sm:px-6 sm:pt-6",
      className,
    )}
    {...props}
  >
    {icon ? (
      <div
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-md ring-1 ring-inset",
          "[&_svg]:size-4",
          headerToneStyles[tone],
        )}
      >
        {icon}
      </div>
    ) : null}
    <div className="flex-1 min-w-0 space-y-1 pr-8">{children}</div>
  </div>
);
DialogHeader.displayName = "DialogHeader";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-[15px] font-semibold leading-tight tracking-tight text-foreground",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(
      "text-[12.5px] text-muted-foreground leading-relaxed",
      className,
    )}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex-1 overflow-y-auto px-5 pb-5 pt-1 sm:px-6 sm:pb-6 scrollbar-thin",
      className,
    )}
    {...props}
  />
);
DialogBody.displayName = "DialogBody";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 px-5 py-3.5 sm:px-6",
      "border-t border-border bg-surface-1/60",
      "sm:flex-row sm:items-center sm:justify-end sm:gap-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
