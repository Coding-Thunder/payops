"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { GripVerticalIcon, PlusIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  EMAIL_BLOCK_KEYS,
  ITEM_ATTRIBUTE_TYPES,
  ITEM_PRICING_MODELS,
  ItemAttributeType,
  ItemPricingModel,
  type EmailBlockKey,
} from "@/lib/constants/items";
import type {
  ItemTypeAttributeDTO,
  ItemTypeDTO,
} from "@/server/services/item-type.service";

interface ItemTypeFormProps {
  /** Edit mode binds to an existing row; create mode binds to a blank
   *  template the user fills in. */
  initial?: ItemTypeDTO;
}

interface FormState {
  key: string;
  name: string;
  description: string;
  pricingModel: ItemPricingModel;
  requiresScheduling: boolean;
  inventoryTracked: boolean;
  attributeSchema: ItemTypeAttributeDTO[];
  confirmationEmailBlocks: EmailBlockKey[];
}

function blankAttribute(displayOrder: number): ItemTypeAttributeDTO {
  return {
    key: "",
    label: "",
    type: ItemAttributeType.STRING,
    required: false,
    options: undefined,
    helpText: "",
    displayOrder,
  };
}

function toFormState(initial?: ItemTypeDTO): FormState {
  if (!initial) {
    return {
      key: "",
      name: "",
      description: "",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    };
  }
  return {
    key: initial.key,
    name: initial.name,
    description: initial.description ?? "",
    pricingModel: initial.pricingModel,
    requiresScheduling: initial.requiresScheduling,
    inventoryTracked: initial.inventoryTracked,
    attributeSchema: initial.attributeSchema.map((a) => ({
      ...a,
      helpText: a.helpText ?? "",
    })),
    confirmationEmailBlocks: initial.confirmationEmailBlocks,
  };
}

export function ItemTypeForm({ initial }: ItemTypeFormProps) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => toFormState(initial));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial);

  const sortedAttrs = useMemo(
    () =>
      [...state.attributeSchema].sort(
        (a, b) => a.displayOrder - b.displayOrder,
      ),
    [state.attributeSchema],
  );

  function updateAttr(idx: number, patch: Partial<ItemTypeAttributeDTO>): void {
    setState((s) => ({
      ...s,
      attributeSchema: s.attributeSchema.map((a, i) =>
        i === idx ? { ...a, ...patch } : a,
      ),
    }));
  }

  function addAttr(): void {
    setState((s) => ({
      ...s,
      attributeSchema: [
        ...s.attributeSchema,
        blankAttribute(s.attributeSchema.length),
      ],
    }));
  }

  function removeAttr(idx: number): void {
    setState((s) => ({
      ...s,
      attributeSchema: s.attributeSchema
        .filter((_, i) => i !== idx)
        .map((a, i) => ({ ...a, displayOrder: i })),
    }));
  }

  function toggleEmailBlock(key: EmailBlockKey): void {
    setState((s) => ({
      ...s,
      confirmationEmailBlocks: s.confirmationEmailBlocks.includes(key)
        ? s.confirmationEmailBlocks.filter((k) => k !== key)
        : [...s.confirmationEmailBlocks, key],
    }));
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const payload = {
      key: state.key.trim().toLowerCase(),
      name: state.name.trim(),
      description: state.description.trim() || null,
      pricingModel: state.pricingModel,
      requiresScheduling: state.requiresScheduling,
      inventoryTracked: state.inventoryTracked,
      attributeSchema: state.attributeSchema.map((a, idx) => ({
        ...a,
        key: a.key.trim().toLowerCase(),
        label: a.label.trim(),
        helpText: a.helpText?.trim() || null,
        displayOrder: idx,
        options:
          a.type === ItemAttributeType.SELECT
            ? (a.options ?? []).map((o) => o.trim()).filter(Boolean)
            : undefined,
      })),
      confirmationEmailBlocks: state.confirmationEmailBlocks,
    };

    try {
      if (isEdit && initial) {
        const { key: _key, ...rest } = payload;
        await api.patch(`/api/admin/item-types/${initial.id}`, rest);
        toast.success("Item type updated");
      } else {
        await api.post("/api/admin/item-types", payload);
        toast.success("Item type created");
      }
      startTransition(() => {
        router.push("/app/admin/item-types");
        router.refresh();
      });
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not save item type";
      setError(message);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}

      {/* ── Identity ───────────────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="item-type-key">Key</Label>
          <Input
            id="item-type-key"
            value={state.key}
            onChange={(e) => setState((s) => ({ ...s, key: e.target.value }))}
            placeholder="milk_carton"
            disabled={isEdit}
            required
            maxLength={32}
          />
          <p className="text-[11.5px] text-muted-foreground">
            Lowercase, snake_case. Used on every order&apos;s line snapshot
            forever; cannot be renamed.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-type-name">Display name</Label>
          <Input
            id="item-type-name"
            value={state.name}
            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            placeholder="Milk carton"
            required
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="item-type-description">Description</Label>
          <Textarea
            id="item-type-description"
            value={state.description}
            onChange={(e) =>
              setState((s) => ({ ...s, description: e.target.value }))
            }
            placeholder="What this item type represents in your workflow."
            rows={2}
            maxLength={500}
          />
        </div>
      </section>

      {/* ── Behavior ───────────────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="item-type-pricing">Pricing model</Label>
          <Select
            value={state.pricingModel}
            onValueChange={(v) =>
              setState((s) => ({
                ...s,
                pricingModel: v as ItemPricingModel,
              }))
            }
          >
            <SelectTrigger id="item-type-pricing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ITEM_PRICING_MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pt-6">
          <Checkbox
            checked={state.requiresScheduling}
            onCheckedChange={(v) =>
              setState((s) => ({ ...s, requiresScheduling: v === true }))
            }
          />
          <span className="text-[13px]">Requires scheduling</span>
        </label>
        <label className="flex items-center gap-2 pt-6">
          <Checkbox
            checked={state.inventoryTracked}
            onCheckedChange={(v) =>
              setState((s) => ({ ...s, inventoryTracked: v === true }))
            }
          />
          <span className="text-[13px]">Inventory tracked</span>
        </label>
      </section>

      {/* ── Attribute schema ───────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold">Attributes</h3>
            <p className="text-[12px] text-muted-foreground">
              Fields the create-order form will ask for whenever an order
              uses this item type.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addAttr}
          >
            <PlusIcon className="size-3.5" />
            Add attribute
          </Button>
        </div>

        {sortedAttrs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted-foreground">
            No attributes yet. Click &ldquo;Add attribute&rdquo; to define the
            first one.
          </div>
        ) : null}

        {sortedAttrs.map((attr) => {
          const idx = state.attributeSchema.indexOf(attr);
          return (
            <div
              key={`${idx}-${attr.key || "blank"}`}
              className="grid gap-3 rounded-lg border border-border bg-card/50 p-3 sm:grid-cols-[24px_1fr_1fr_1fr_120px_36px] sm:items-end"
            >
              <GripVerticalIcon className="size-4 self-center text-muted-foreground" />
              <div className="space-y-1">
                <Label className="text-[11px]">Key</Label>
                <Input
                  value={attr.key}
                  onChange={(e) =>
                    updateAttr(idx, { key: e.target.value })
                  }
                  placeholder="carton_size"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Label</Label>
                <Input
                  value={attr.label}
                  onChange={(e) =>
                    updateAttr(idx, { label: e.target.value })
                  }
                  placeholder="Carton size"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Type</Label>
                <Select
                  value={attr.type}
                  onValueChange={(v) =>
                    updateAttr(idx, {
                      type: v as ItemAttributeType,
                      options:
                        v === ItemAttributeType.SELECT
                          ? (attr.options ?? [""])
                          : undefined,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEM_ATTRIBUTE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 pb-2">
                <Checkbox
                  checked={attr.required}
                  onCheckedChange={(v) =>
                    updateAttr(idx, { required: v === true })
                  }
                />
                <span className="text-[12px]">Required</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="self-center"
                onClick={() => removeAttr(idx)}
                aria-label="Remove attribute"
              >
                <TrashIcon className="size-3.5" />
              </Button>
              {attr.type === ItemAttributeType.SELECT ? (
                <div className="sm:col-span-6 space-y-1">
                  <Label className="text-[11px]">
                    Options (comma-separated)
                  </Label>
                  <Input
                    value={(attr.options ?? []).join(", ")}
                    onChange={(e) =>
                      updateAttr(idx, {
                        options: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="500ml, 1L, 2L"
                  />
                </div>
              ) : null}
              <div className="sm:col-span-6 space-y-1">
                <Label className="text-[11px]">Help text</Label>
                <Input
                  value={attr.helpText ?? ""}
                  onChange={(e) =>
                    updateAttr(idx, { helpText: e.target.value })
                  }
                  placeholder="Optional. Rendered under the input."
                />
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Email blocks ───────────────────────────────────────────── */}
      <section className="space-y-2">
        <div>
          <h3 className="text-[14px] font-semibold">
            Confirmation email blocks
          </h3>
          <p className="text-[12px] text-muted-foreground">
            Optional. Pick which blocks the confirmation email renders for
            orders of this type. Default blocks (payment summary, line
            items, totals, terms, support) always render.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {EMAIL_BLOCK_KEYS.map((k) => (
            <label
              key={k}
              className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-[12.5px]"
            >
              <Checkbox
                checked={state.confirmationEmailBlocks.includes(k)}
                onCheckedChange={() => toggleEmailBlock(k)}
              />
              <span className="font-mono text-[11.5px]">{k}</span>
            </label>
          ))}
        </div>
      </section>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/app/admin/item-types")}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isEdit ? "Save changes" : "Create item type"}
        </Button>
      </div>
    </form>
  );
}
