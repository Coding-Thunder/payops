"use client";

import { useFormContext } from "react-hook-form";

import {
  FormControl,
  FormDescription,
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
import type { Currency } from "@/lib/constants/enums";
import type { FlightOrderInput } from "@/lib/validation";

import { FlightAmountsSummary } from "./flight-amounts-summary";
import type { FlightOrderFormValues } from "./itinerary-form";

/** A money input's value: blank while empty (the form holds null). */
function amountValue(value: unknown): string | number {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

/** What a money input hands the form: null while blank, else the number. */
function amountChange(raw: string): number | null {
  return raw === "" ? null : Number(raw);
}

/**
 * The flight form's money: currency, the AIRLINE CHARGE, and the charge the
 * payment link collects — its NAME and its amount.
 *
 * The airline charge is `flight.airlineFare`, its own field on the flight
 * with a fixed label: shown to the customer for the total booking value,
 * never a charge line, so it can never reach the payment link. The
 * collected charge is the order's one charge line (`charges[0]`), named by
 * the operator — "Service Charge" unless changed (Processing Fee, Booking
 * Fee, Agency Fee…) — and that name is what the customer sees everywhere.
 * The amounts start blank and are required (the airline charge takes 0
 * when there is none), so neither can be forgotten into a 0.
 *
 * Not the rental `ChargeLinesFieldset`: a flight has no "+ Add charge",
 * so an airline charge can never be entered as a second line and charged.
 */
export function FlightMoneyFields({
  allowedCurrencies,
  defaultCurrency,
  disabled = false,
}: {
  allowedCurrencies: readonly string[];
  defaultCurrency: Currency;
  disabled?: boolean;
}) {
  const { control } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();

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

      <div className="sm:max-w-[calc(50%-0.5rem)]">
        <FormField
          control={control}
          name="flight.airlineFare"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Airline charge</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={disabled}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={amountValue(field.value)}
                  onChange={(e) => field.onChange(amountChange(e.target.value))}
                />
              </FormControl>
              <FormDescription>
                Shown to the customer for the total booking value — never
                collected through the payment link. Enter 0 if there is none.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name="charges.0.name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Charge name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Service Charge, Processing Fee"
                  maxLength={120}
                  disabled={disabled}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={typeof field.value === "string" ? field.value : ""}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FormControl>
              <FormDescription>
                What the customer sees this payment called.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="charges.0.amount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Amount</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={disabled}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={amountValue(field.value)}
                  onChange={(e) => field.onChange(amountChange(e.target.value))}
                />
              </FormControl>
              <FormDescription>
                The only amount the payment link collects.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FlightAmountsSummary defaultCurrency={defaultCurrency} />
    </>
  );
}
