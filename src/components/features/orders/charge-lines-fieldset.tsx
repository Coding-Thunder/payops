"use client";

import { useFieldArray, useWatch, type Control } from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaymentTimingLabel } from "@/lib/constants/labels";
import {
  type Currency,
  PAYMENT_TIMINGS,
  PaymentTiming,
} from "@/lib/constants/enums";
import { summarizeCharges } from "@/lib/charges";
import { formatCurrency } from "@/lib/format";

/**
 * The money half of an order form — currency, the charge lines, and the
 * live prepaid / due-later / total breakdown.
 *
 * VERBATIM EXTRACTION. Every element, class name and string below was moved
 * out of `create-order-form.tsx` unchanged, so the car-rental form renders
 * byte-identical markup to what it rendered before this component existed.
 * The two labels that name the rental counter are props whose DEFAULTS are
 * the exact rental strings, which is the only reason flight and cruise can
 * share this without touching the rental output.
 *
 * The component deliberately renders a fragment, not a wrapper element: it
 * sits directly inside `<CardContent className="space-y-4">` in all three
 * forms, and an extra <div> would change the rental spacing.
 *
 * `charges` and `currency` live at the same paths in all three branch
 * schemas (rental / flight / cruise), so the fieldset is typed against that
 * shared slice and each form casts its own `control` to it at the call
 * site. That is the pragmatic alternative to making this component generic
 * over `FieldValues`: RHF's path generics would force a cast on every
 * single `field.value` inside instead of one cast per caller.
 */
export interface ChargeLinesFormValues {
  currency: Currency;
  /** `amount` is `number | string` because the number input round-trips an
   *  empty string while the agent is clearing the field; the schema rejects
   *  anything non-numeric on submit. */
  charges: { name: string; amount: number | string; timing: PaymentTiming }[];
}

interface ChargeLinesFieldsetProps {
  control: Control<ChargeLinesFormValues>;
  allowedCurrencies: readonly string[];
  defaultCurrency: Currency;
  disabled?: boolean;
  /** Placeholder on an empty charge-name input. Names the service's most
   *  common first line so the agent sees an example that fits the tab. */
  namePlaceholder?: string;
  /** Breakdown row copy. Defaults are the strings the car-rental form has
   *  always shown — never change them. */
  dueLaterLabel?: string;
  totalLabel?: string;
}

export function ChargeLinesFieldset({
  control,
  allowedCurrencies,
  defaultCurrency,
  disabled = false,
  namePlaceholder = "e.g. Rental cost",
  dueLaterLabel = "Amount due at counter",
  totalLabel = "Total rental cost",
}: ChargeLinesFieldsetProps) {
  const chargeFields = useFieldArray({ control, name: "charges" });

  // Live breakdown for the summary box — recomputed from the same helper the
  // server uses, so what the agent sees here is exactly what gets charged.
  const watchedCharges = useWatch({ control, name: "charges" });
  const watchedCurrency =
    useWatch({ control, name: "currency" }) ?? defaultCurrency;
  const chargeSummary = summarizeCharges(
    (watchedCharges ?? []).map((c) => ({
      name: c?.name ?? "",
      amount: typeof c?.amount === "number" ? c.amount : Number(c?.amount) || 0,
      timing: (c?.timing as PaymentTiming) ?? PaymentTiming.PREPAID,
    })),
  );

  return (
    <>
      <FormField
        control={control}
        name="currency"
        render={({ field }) => (
          <FormItem className="max-w-[200px]">
            <FormLabel>Currency</FormLabel>
            <Select
              value={field.value ?? defaultCurrency}
              onValueChange={field.onChange}
              disabled={disabled}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Currency" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {allowedCurrencies.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="space-y-3">
        {chargeFields.fields.map((row, index) => (
          <div
            key={row.id}
            className="grid gap-3 sm:grid-cols-[1fr_140px_170px_auto] sm:items-end"
          >
            <FormField
              control={control}
              name={`charges.${index}.name`}
              render={({ field }) => (
                <FormItem>
                  {index === 0 ? <FormLabel>Charge name</FormLabel> : null}
                  <FormControl>
                    <Input
                      placeholder={namePlaceholder}
                      disabled={disabled}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`charges.${index}.amount`}
              render={({ field }) => (
                <FormItem>
                  {index === 0 ? <FormLabel>Amount</FormLabel> : null}
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      placeholder="0.00"
                      disabled={disabled}
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? "" : Number(e.target.value),
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={control}
              name={`charges.${index}.timing`}
              render={({ field }) => (
                <FormItem>
                  {index === 0 ? <FormLabel>Payment timing</FormLabel> : null}
                  <Select
                    value={field.value ?? PaymentTiming.PREPAID}
                    onValueChange={field.onChange}
                    disabled={disabled}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Timing" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_TIMINGS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {PaymentTimingLabel[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button
              type="button"
              variant="ghost"
              onClick={() => chargeFields.remove(index)}
              disabled={disabled || chargeFields.fields.length <= 1}
              aria-label="Remove charge"
            >
              Remove
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            chargeFields.append({
              name: "",
              amount: 0,
              timing: PaymentTiming.PREPAID,
            })
          }
          disabled={disabled}
        >
          + Add charge
        </Button>
      </div>

      {/* Live breakdown — uses the same helper the server uses, so the
          agent sees exactly what will be charged online. */}
      <div className="space-y-1.5 rounded-md border bg-muted/30 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            Amount paid online (today)
          </span>
          <span className="font-medium tabular-nums">
            {formatCurrency(chargeSummary.prepaid, watchedCurrency)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{dueLaterLabel}</span>
          <span className="font-medium tabular-nums">
            {formatCurrency(chargeSummary.dueAtCounter, watchedCurrency)}
          </span>
        </div>
        <div className="flex items-center justify-between border-t pt-1.5">
          <span className="font-medium">{totalLabel}</span>
          <span className="font-semibold tabular-nums">
            {formatCurrency(chargeSummary.total, watchedCurrency)}
          </span>
        </div>
        <p className="pt-1 text-xs text-muted-foreground">
          The payment link charges only the{" "}
          <strong>
            {formatCurrency(chargeSummary.prepaid, watchedCurrency)}
          </strong>{" "}
          prepaid amount.
        </p>
      </div>
    </>
  );
}
