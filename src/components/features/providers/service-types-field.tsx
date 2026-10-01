"use client";

import { Checkbox } from "@/components/ui/checkbox";
import {
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { SERVICE_TYPES, ServiceType } from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";

/**
 * Which services a supplier may be selected for.
 *
 * Shared by the create and edit provider dialogs so the two cannot drift.
 * Deliberately a checkbox pair rather than a multi-select: there are two
 * options, "both" is a legitimate answer, and a two-item multi-select is
 * more clicks and less legible than two checkboxes.
 *
 * Unchecking the last box is prevented here as well as in the schema. The
 * schema is the real guard; this just means the operator finds out before
 * submitting rather than after.
 */
interface ServiceTypesFieldProps {
  value: ServiceType[] | undefined;
  onChange: (next: ServiceType[]) => void;
  disabled?: boolean;
}

export function ServiceTypesField({
  value,
  onChange,
  disabled,
}: ServiceTypesFieldProps) {
  // A supplier with nothing stored predates the field and is car-rental —
  // the same rule the server-side filter and the tab narrowing both use.
  const selected =
    value && value.length > 0 ? value : [ServiceType.CAR_RENTAL];

  function toggle(type: ServiceType, checked: boolean) {
    const next = checked
      ? Array.from(new Set([...selected, type]))
      : selected.filter((t) => t !== type);
    // Never allow the last one off — a supplier usable for nothing would
    // silently disappear from every create form.
    if (next.length === 0) return;
    onChange(next);
  }

  return (
    <FormItem>
      <FormLabel>Available for</FormLabel>
      {/* Deliberately NOT wrapped in <FormControl>. That is a Radix `Slot`,
          which clones a single child and throws React.Children.only — it is
          meant for one focusable control, not a checkbox group. Wrapping this
          group in it crashed the whole providers page. */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
          {SERVICE_TYPES.map((type) => {
            const checked = selected.includes(type);
            return (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled || (checked && selected.length === 1)}
                  onCheckedChange={(v) => toggle(type, v === true)}
                />
                <span>{ServiceTypeLabel[type]}</span>
              </label>
            );
          })}
      </div>
      <FormDescription>
        Controls which create-order tab offers this supplier.
      </FormDescription>
      <FormMessage />
    </FormItem>
  );
}
