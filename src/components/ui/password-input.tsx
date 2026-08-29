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
        // `type="button"` so it can never submit the surrounding form.
        type="button"
        onClick={toggle}
        // Keep the caret in the input. `tabIndex={-1}` alone only removes
        // the button from the TAB ORDER — a click would still move focus to
        // it in Chrome and Safari, so the user would lose their place
        // mid-typing. Preventing the default on mousedown stops the focus
        // shift before it happens, while leaving the click itself intact.
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
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
