"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { LoadingButton } from "@/components/ui/loading-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import type { OrderDTO } from "@/types";

interface ConfirmationNumberCardProps {
  order: OrderDTO;
}

/**
 * Staff-editable supplier confirmation number. Agents paste the value the
 * supplier returns once the booking is confirmed; it surfaces at the top of
 * the customer's confirmation email. Server enforces order ownership.
 */
export function ConfirmationNumberCard({ order }: ConfirmationNumberCardProps) {
  const router = useRouter();
  const current = order.confirmationNumber ?? "";
  // Seed the input from the persisted value. After a save we call
  // router.refresh(), but `value` already holds the saved text the agent
  // typed, so the field stays correct without a sync effect.
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);

  const dirty = value.trim() !== current;

  async function save() {
    setSaving(true);
    try {
      await api.post(`/api/orders/${order.id}/confirmation-number`, {
        confirmationNumber: value.trim(),
      });
      toast.success(
        value.trim() ? "Confirmation number saved" : "Confirmation number cleared",
      );
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not save the confirmation number";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirmation number</CardTitle>
        <CardDescription>
          Paste the supplier confirmation number. It appears at the top of the
          customer&apos;s confirmation email.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. ABC-12345678"
            maxLength={64}
            disabled={saving}
            className="font-mono"
          />
          <div className="flex gap-2">
            <LoadingButton
              size="sm"
              onClick={save}
              loading={saving}
              loadingText="Saving"
              disabled={!dirty}
            >
              Save
            </LoadingButton>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setValue(current)}
                disabled={saving}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </div>
        {!current ? (
          <p className="text-[11.5px] text-muted-foreground">
            No confirmation number set yet.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
