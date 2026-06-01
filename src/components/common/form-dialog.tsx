"use client";

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

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  title: string;
  description?: string;

  /** Optional icon shown in a tinted square next to the title. */
  icon?: React.ReactNode;
  /** Tone for the icon background, default is brand. */
  tone?: DialogHeaderTone;

  /** Content (form fields). */
  children: React.ReactNode;

  /** Width preset. Defaults to "md" (480px). */
  size?: "sm" | "md" | "lg" | "xl";

  /** Submit button label. Defaults to "Save". */
  submitLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Submit button variant. Defaults to "default". */
  submitVariant?: ButtonProps["variant"];

  /** Async submit handler. Disables the submit while the promise is in-flight. */
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void | Promise<void>;

  /** External pending state when the parent component manages submission. */
  pending?: boolean;
  /** Disables submit even when not pending (e.g. invalid form). */
  submitDisabled?: boolean;

  /** Extra footer slot rendered on the left side (status text, secondary actions). */
  footerLeading?: React.ReactNode;
  /** Skip closing-on-overlay-click (useful for destructive flows). */
  preventOverlayClose?: boolean;

  className?: string;
}

/**
 * Standard form-in-a-dialog wrapper. Caller renders fields inside, this
 * component owns:
 *   - the surface, header, scrollable body, sticky footer
 *   - the form element, the cancel/submit buttons, and the pending state
 *
 * Use this for every form dialog so spacing and interaction model stay
 * identical site-wide.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone = "default",
  children,
  size = "md",
  submitLabel = "Save",
  cancelLabel = "Cancel",
  submitVariant = "default",
  onSubmit,
  pending = false,
  submitDisabled = false,
  footerLeading,
  preventOverlayClose,
  className,
}: FormDialogProps) {
  const [internalPending, setInternalPending] = React.useState(false);
  const isPending = pending || internalPending;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The dialog is rendered via Radix Portal, so its DOM lives in
    // document.body, but the React tree still descends from whatever
    // parent rendered the dialog. React synthetic events bubble through
    // the React tree (not the DOM tree), which means a submit on this
    // form would also trigger any ancestor <form>'s submit. Stop the
    // event here so nested-form scenarios stay isolated.
    event.stopPropagation();
    if (isPending) return;
    const result = onSubmit(event);
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
        size={size}
        className={cn("max-h-[min(90vh,720px)]", className)}
        onInteractOutside={
          preventOverlayClose ? (e) => e.preventDefault() : undefined
        }
        onEscapeKeyDown={
          preventOverlayClose ? (e) => e.preventDefault() : undefined
        }
      >
        <form
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col min-h-0 flex-1"
          aria-busy={isPending || undefined}
        >
          <DialogHeader icon={icon} tone={tone}>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>

          <DialogBody className={isPending ? "pointer-events-none opacity-80" : undefined}>
            {children}
          </DialogBody>

          <DialogFooter>
            {footerLeading ? (
              <div className="flex flex-1 items-center text-[12px] text-muted-foreground">
                {footerLeading}
              </div>
            ) : null}
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
              type="submit"
              variant={submitVariant}
              size="sm"
              disabled={isPending || submitDisabled}
              aria-busy={isPending || undefined}
            >
              {isPending ? <Spinner size="xs" tone="current" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
