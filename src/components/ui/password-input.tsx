"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PasswordInputProps
  extends Omit<React.ComponentProps<"input">, "type"> {
  /** Force the visible state. Useful for fully controlled forms. */
  visible?: boolean;
  /** Callback when the user toggles visibility. */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * Password input with an inline eye-toggle. Keeps a single source of
 * truth for password fields so reset-password, login, and admin password
 * dialogs all behave identically.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  PasswordInputProps
>(({ className, visible: visibleProp, onVisibilityChange, ...props }, ref) => {
  const [internalVisible, setInternalVisible] = React.useState(false);
  const visible = visibleProp ?? internalVisible;

  function toggle() {
    const next = !visible;
    if (visibleProp === undefined) setInternalVisible(next);
    onVisibilityChange?.(next);
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        autoComplete={props.autoComplete ?? "new-password"}
        className="pr-9"
        {...props}
      />
      <button
        // `type="button"` is load-bearing: the default inside a <form> is
        // "submit", so without it revealing the password would post the
        // login form.
        type="button"
        onClick={toggle}
        // Keep the caret where the user left it. A button takes focus on
        // mousedown, which would pull it out of the field mid-typing;
        // cancelling the default focus transfer leaves the input focused
        // while still firing the click.
        onMouseDown={(e) => e.preventDefault()}
        // Reachable by keyboard on purpose. This is real functionality, and
        // functionality that only a mouse can operate fails WCAG 2.1.1.
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 grid size-6 place-items-center rounded-sm",
          "text-muted-foreground hover:text-foreground",
          "transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {visible ? (
          <EyeOffIcon className="size-3.5" />
        ) : (
          <EyeIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
