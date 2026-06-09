"use client";

import { AlertTriangleIcon } from "lucide-react";
import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DialogHeaderTone,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  title: string;
  description?: React.ReactNode;

  /** Optional extra content rendered above the actions. */
  children?: React.ReactNode;

  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;

  /**
   * Visual treatment. "destructive" tints the header icon red and the
   * primary action red. Defaults to "default" (neutral primary).
   */
  tone?: "default" | "destructive" | "warning" | "info";

  /** Replace the default icon. */
  icon?: React.ReactNode;

  /** Async confirm handler. The dialog stays open while the promise is in-flight. */
  onConfirm: () => void | Promise<void>;

  pending?: boolean;
  className?: string;
}

const toneIconMap: Record<NonNullable<ConfirmDialogProps["tone"]>, React.ReactNode> = {
  default: <AlertTriangleIcon />,
  destructive: <AlertTriangleIcon />,
  warning: <AlertTriangleIcon />,
  info: <AlertTriangleIcon />,
};

const toneToHeaderTone: Record<
  NonNullable<ConfirmDialogProps["tone"]>,
  DialogHeaderTone
> = {
  default: "default",
  destructive: "destructive",
  warning: "warning",
  info: "info",
};

const toneToButtonVariant: Record<
  NonNullable<ConfirmDialogProps["tone"]>,
  ButtonProps["variant"]
> = {
  default: "default",
  destructive: "destructive",
  warning: "default",
  info: "default",
};

/**
 * Confirmation dialog used for destructive / sensitive actions. Compact
 * (420px) by default, semantic tone drives the icon + primary-button
 * color so destructive actions are always visually recognisable.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  icon,
  onConfirm,
  pending = false,
  className,
}: ConfirmDialogProps) {
  const [internalPending, setInternalPending] = React.useState(false);
  const isPending = pending || internalPending;

  async function handleConfirm() {
    if (isPending) return;
    const result = onConfirm();
    if (result instanceof Promise) {
      setInternalPending(true);
      try {
        await result;
      } finally {
        setInternalPending(false);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        className={cn("max-h-[min(80vh,520px)]", className)}
      >
        <DialogHeader icon={icon ?? toneIconMap[tone]} tone={toneToHeaderTone[tone]}>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {children ? <DialogBody className="pt-2">{children}</DialogBody> : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={toneToButtonVariant[tone]}
            onClick={handleConfirm}
            disabled={isPending}
            aria-busy={isPending || undefined}
          >
            {isPending ? <Spinner size="xs" tone="current" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
