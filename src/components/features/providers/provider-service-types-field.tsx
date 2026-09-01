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
 * Which order forms a supplier appears on.
 *
 * Rendered as checkboxes rather than a multi-select because the list is
 * three items long and a supplier commonly serves more than one — a
 * consolidator sells both flights and cruises — so the whole choice should
 * be visible without opening anything.
 *
 * SHOWN ONLY WHEN THE DEPLOYMENT SELLS MORE THAN ONE SERVICE. On a
 * single-service console every supplier is necessarily that service, and a
 * mandatory checkbox with one option is a question with one answer; the
 * dialogs default the value instead so the payload is still explicit.
 *
 * Deliberately uncontrolled by `FormField`: the value is an array and the
 * control is a set of checkboxes, so wiring it through RHF's single-value
 * `field` adapter would mean reimplementing the toggle logic inside a
 * render prop. The dialogs own the value and pass it down.
 */

interface ProviderServiceTypesFieldProps {
  value: readonly ServiceType[];
  onChange: (next: ServiceType[]) => void;
  disabled?: boolean;
  /** Validation message from the schema, when the list came back empty. */
  error?: string;
}

export function ProviderServiceTypesField({
  value,
  onChange,
  disabled = false,
  error,
}: ProviderServiceTypesFieldProps) {
  function toggle(serviceType: ServiceType, checked: boolean) {
    // Preserve the enum's canonical order regardless of click order, so two
    // suppliers with the same services store byte-identical arrays and the
    // update path's sorted comparison sees no spurious change.
    const next = SERVICE_TYPES.filter((t) =>
      t === serviceType ? checked : value.includes(t),
    );
    onChange(next);
  }

  return (
    <FormItem>
      <FormLabel>Available for</FormLabel>
      <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
        {SERVICE_TYPES.map((t) => {
          const id = `provider-service-${t.toLowerCase()}`;
          return (
            <label
              key={t}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-2 text-sm font-normal"
            >
              <Checkbox
                id={id}
                checked={value.includes(t)}
                onCheckedChange={(c) => toggle(t, c === true)}
                disabled={disabled}
              />
              {ServiceTypeLabel[t]}
            </label>
          );
        })}
      </div>
      <FormDescription>
        Which order forms this supplier can be selected on.
      </FormDescription>
      {error ? <FormMessage>{error}</FormMessage> : null}
    </FormItem>
  );
}
