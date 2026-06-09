"use client";

import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface LoadingButtonProps extends ButtonProps {
  /** When true, shows an inline spinner and disables the button. */
  loading?: boolean;
  /** Optional label to display while loading. Defaults to the children. */
  loadingText?: React.ReactNode;
  /**
   * Prevents the same click from firing twice while a promise from onClick
   * resolves. Useful for actions that don't manage their own pending state.
   */
  autoBusyOnClick?: boolean;
  /** Optional leading icon when not loading. */
  icon?: React.ReactNode;
}

/**
 * Drop-in replacement for `<Button>` that owns the loading affordance:
 *  - shows a Spinner before the label
 *  - disables interaction while loading
 *  - exposes `aria-busy` for assistive tech
 *  - optionally auto-tracks an async onClick to block double-submits
 */
export const LoadingButton = React.forwardRef<
  HTMLButtonElement,
  LoadingButtonProps
>(function LoadingButton(
  {
    loading = false,
    loadingText,
    autoBusyOnClick = false,
    icon,
    disabled,
    children,
    className,
    onClick,
    size,
    ...props
  },
  ref,
) {
  const [internalBusy, setInternalBusy] = React.useState(false);
  const isLoading = loading || internalBusy;

  async function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (isLoading) {
      e.preventDefault();
      return;
    }
    if (!onClick) return;
    // React's MouseEventHandler is typed `void`, but consumers commonly
    // return a Promise from async click handlers. Coerce to `unknown` so
    // the instanceof check type-checks without losing the runtime guard.
    const result = onClick(e) as unknown;
    if (autoBusyOnClick && result instanceof Promise) {
      setInternalBusy(true);
      try {
        await result;
      } finally {
        setInternalBusy(false);
      }
    }
  }

  const spinnerSize = size === "sm" || size === "icon-sm" ? "xs" : "sm";

  return (
    <Button
      ref={ref}
      size={size}
      className={cn(className)}
      aria-busy={isLoading || undefined}
      disabled={disabled || isLoading}
      onClick={handleClick}
      {...props}
    >
      {isLoading ? (
        <Spinner size={spinnerSize} tone="current" />
      ) : icon ? (
        icon
      ) : null}
      {isLoading && loadingText ? loadingText : children}
    </Button>
  );
});
