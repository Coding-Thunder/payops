"use client";

import * as React from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  groupedVariables,
  variableToken,
  type VariableAvailability,
} from "@/lib/constants/email-variables";

interface InsertVariableMenuProps {
  /** What this email actually knows. Order and payment groups only
   *  appear when the context can satisfy them — offering
   *  `{{invoice_number}}` on an email with no invoice is how you end up
   *  sending a blank where a number should be. */
  availability: VariableAvailability;
  onInsert: (token: string) => void;
  label?: string;
  disabled?: boolean;
}

/**
 * Insert → Client → Client Name.
 *
 * Operators never type `{{client_name}}`. They pick the thing they mean
 * from a menu grouped by where the value comes from, and the editor
 * writes the token. The menu is the only place the syntax exists in the
 * user's world.
 */
export function InsertVariableMenu({
  availability,
  onInsert,
  label = "Insert",
  disabled = false,
}: InsertVariableMenuProps) {
  const groups = React.useMemo(
    () => groupedVariables(availability),
    [availability],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={disabled}
        >
          <PlusIcon className="size-3.5" />
          {label}
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[420px] overflow-y-auto">
        {groups.map((group, i) => (
          <React.Fragment key={group.group}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.items.map((item) => (
              <DropdownMenuItem
                key={item.token}
                onSelect={() => onInsert(variableToken(item.token))}
                className="flex-col items-start gap-0"
              >
                <span>{item.label}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {item.requires === "manual"
                    ? "You'll fill this in"
                    : item.sample}
                </span>
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Insert text at the caret of a textarea/input, keeping the caret after
 * what was inserted so the operator can keep typing mid-sentence.
 *
 * Falls back to appending when the field was never focused — inserting
 * silently at position 0 would drop a token in front of the greeting.
 */
export function insertAtCaret(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  current: string,
  text: string,
): { value: string; caret: number } {
  if (!el || el.selectionStart === null) {
    const joined = current ? `${current}${text}` : text;
    return { value: joined, caret: joined.length };
  }
  const start = el.selectionStart;
  const end = el.selectionEnd ?? start;
  const value = current.slice(0, start) + text + current.slice(end);
  return { value, caret: start + text.length };
}

/** Restore the caret after React re-renders with the new value. */
export function focusCaret(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  caret: number,
): void {
  if (!el) return;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}
