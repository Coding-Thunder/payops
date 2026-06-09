"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { AttributeField } from "@/components/features/orders/attribute-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { CURRENCIES, type Currency } from "@/lib/constants/enums";
import type { ItemDTO } from "@/server/services/item.service";
import type { ItemTypeDTO } from "@/server/services/item-type.service";

interface ItemFormProps {
  itemTypes: ItemTypeDTO[];
  defaultCurrency: Currency;
  initial?: ItemDTO;
}

interface FormState {
  itemTypeKey: string;
  name: string;
  description: string;
  basePrice: string;
  currency: Currency;
  sku: string;
  imageUrl: string;
  attributes: Record<string, unknown>;
}

function emptyState(defaultCurrency: Currency): FormState {
  return {
    itemTypeKey: "",
    name: "",
    description: "",
    basePrice: "",
    currency: defaultCurrency,
    sku: "",
    imageUrl: "",
    attributes: {},
  };
}

function stateFromInitial(initial: ItemDTO): FormState {
  return {
    itemTypeKey: initial.itemTypeKey,
    name: initial.name,
    description: initial.description ?? "",
    basePrice:
      initial.basePrice?.amount !== undefined
        ? String(initial.basePrice.amount)
        : "",
    currency: (initial.basePrice?.currency ?? "USD") as Currency,
    sku: initial.sku ?? "",
    imageUrl: initial.imageUrl ?? "",
    attributes: initial.attributes ?? {},
  };
}

/**
 * Pass 6c, Item catalog form.
 *
 * The attribute section re-renders whenever the operator picks a new
 * ItemType: it pulls that type's `attributeSchema` and shows the right
 * inputs. The shape is identical to the create-order form's per-line
 * attribute section so what an admin sees here matches what operators
 * see at order time.
 */
export function ItemForm({
  itemTypes,
  defaultCurrency,
  initial,
}: ItemFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() =>
    initial ? stateFromInitial(initial) : emptyState(defaultCurrency),
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial);

  const selectedItemType = useMemo(
    () => itemTypes.find((t) => t.key === state.itemTypeKey) ?? null,
    [itemTypes, state.itemTypeKey],
  );

  function updateAttribute(key: string, value: unknown) {
    setState((s) => ({
      ...s,
      attributes: { ...s.attributes, [key]: value },
    }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const basePriceNum = state.basePrice.trim()
      ? Number(state.basePrice)
      : null;
    if (basePriceNum !== null && !Number.isFinite(basePriceNum)) {
      setError("Base price must be a number, or leave blank.");
      return;
    }

    // Drop empty-string attribute values so the validator doesn't
    // see them as "the field is filled" (it'd then refuse on type
    // mismatch). Same convention the order form uses.
    const cleanedAttributes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state.attributes)) {
      if (v === undefined || v === null || v === "") continue;
      cleanedAttributes[k] = v;
    }

    const payload = {
      itemTypeKey: state.itemTypeKey,
      name: state.name.trim(),
      description: state.description.trim() || null,
      basePrice:
        basePriceNum !== null
          ? { amount: basePriceNum, currency: state.currency }
          : null,
      sku: state.sku.trim() || null,
      imageUrl: state.imageUrl.trim() || null,
      attributes: cleanedAttributes,
    };

    try {
      if (isEdit && initial) {
        const { itemTypeKey: _drop, ...rest } = payload;
        void _drop;
        await api.patch(`/api/admin/items/${initial.id}`, rest);
        toast.success("Item updated");
      } else {
        await api.post("/api/admin/items", payload);
        toast.success("Item created");
      }
      startTransition(() => {
        router.push("/app/admin/items");
        router.refresh();
      });
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not save item",
      );
    }
  }

  if (itemTypes.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          No item types yet. Define at least one via{" "}
          <Link href="/app/admin/item-types" className="underline">
            Admin → Item types
          </Link>{" "}
          before adding catalog items.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* ── Identity ──────────────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="item-type">Item type</Label>
          <Select
            value={state.itemTypeKey}
            onValueChange={(v) =>
              setState((s) => ({
                ...s,
                itemTypeKey: v,
                // Reset attributes when switching type, old keys
                // wouldn't validate against the new schema.
                attributes: {},
              }))
            }
            disabled={isEdit}
          >
            <SelectTrigger id="item-type">
              <SelectValue placeholder="Pick an item type" />
            </SelectTrigger>
            <SelectContent>
              {itemTypes.map((t) => (
                <SelectItem key={t.id} value={t.key}>
                  {t.name}{" "}
                  <span className="text-muted-foreground">({t.key})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11.5px] text-muted-foreground">
            {isEdit
              ? "Type is locked, historical orders reference it."
              : "Decides what fields this item carries."}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-name">Name</Label>
          <Input
            id="item-name"
            value={state.name}
            onChange={(e) =>
              setState((s) => ({ ...s, name: e.target.value }))
            }
            placeholder="What operators + customers will see"
            required
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="item-desc">Description (optional)</Label>
          <Textarea
            id="item-desc"
            value={state.description}
            onChange={(e) =>
              setState((s) => ({ ...s, description: e.target.value }))
            }
            placeholder="Internal note or longer customer-facing detail."
            rows={2}
            maxLength={2000}
          />
        </div>
      </section>

      {/* ── Identification + pricing ──────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="item-sku">SKU (optional)</Label>
          <Input
            id="item-sku"
            value={state.sku}
            onChange={(e) => setState((s) => ({ ...s, sku: e.target.value }))}
            placeholder="Your internal code"
            maxLength={64}
          />
          <p className="text-[11.5px] text-muted-foreground">
            Must be unique within your organization.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-price">Base price (optional)</Label>
          <Input
            id="item-price"
            type="number"
            min={0}
            step="0.01"
            value={state.basePrice}
            onChange={(e) =>
              setState((s) => ({ ...s, basePrice: e.target.value }))
            }
            placeholder="Leave blank for quote-per-order"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-ccy">Currency</Label>
          <Select
            value={state.currency}
            onValueChange={(v) =>
              setState((s) => ({ ...s, currency: v as Currency }))
            }
          >
            <SelectTrigger id="item-ccy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* ── Image ─────────────────────────────────────────────────── */}
      <section className="space-y-1.5">
        <Label htmlFor="item-img">Image URL (optional)</Label>
        <Input
          id="item-img"
          type="url"
          value={state.imageUrl}
          onChange={(e) =>
            setState((s) => ({ ...s, imageUrl: e.target.value }))
          }
          placeholder="https://…"
        />
        <p className="text-[11.5px] text-muted-foreground">
          Surfaced on the order page + the confirmation email hero block.
        </p>
      </section>

      {/* ── Per-itemType attributes ───────────────────────────────── */}
      {selectedItemType && selectedItemType.attributeSchema.length > 0 ? (
        <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
          <div>
            <h3 className="text-[13px] font-semibold">
              {selectedItemType.name} attributes
            </h3>
            <p className="text-[11.5px] text-muted-foreground">
              These pre-fill on every order line that picks this item from
              the catalog.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[...selectedItemType.attributeSchema]
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((spec) => (
                <AttributeField
                  key={spec.key}
                  spec={spec}
                  value={state.attributes[spec.key]}
                  onChange={(v) => updateAttribute(spec.key, v)}
                />
              ))}
          </div>
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/app/admin/items")}
          disabled={isPending}
        >
          Cancel
        </Button>
        <LoadingButton type="submit" loading={isPending}>
          {isEdit ? "Save changes" : "Add item"}
        </LoadingButton>
      </div>
    </form>
  );
}
