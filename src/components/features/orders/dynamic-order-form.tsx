"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { PackageIcon, PlusIcon, TrashIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getItemTypeDisplayName } from "@/lib/display/item-type";
import { Button } from "@/components/ui/button";
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
import type { Currency } from "@/lib/constants/enums";
import { SchedulingType } from "@/lib/constants/items";
import type {
  ItemTypeAttributeDTO,
  ItemTypeDTO,
} from "@/server/services/item-type.service";
import type { ItemDTO } from "@/server/services/item.service";

import { AttributeField } from "./attribute-field";

interface DynamicOrderFormProps {
  itemTypes: ItemTypeDTO[];
  /** Pass 6c — pre-saved catalog rows the operator can pick instead of
   *  re-typing line details. May be empty (catalog is optional). */
  catalogItems?: ItemDTO[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly Currency[];
}

interface LineDraft {
  /** Local key for React; the server never sees this. */
  localId: string;
  itemTypeKey: string;
  /** Optional pointer back into the catalog. Surfaces on the order
   *  line so historical orders can link to the catalog row even after
   *  it's been edited / archived. */
  itemId?: string | null;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
  attributes: Record<string, unknown>;
}

interface SchedulingDraft {
  type: SchedulingType;
  startsAt: string;
  endsAt: string;
}

function newLine(itemType: ItemTypeDTO): LineDraft {
  return {
    localId:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    itemTypeKey: itemType.key,
    name: itemType.name,
    description: "",
    quantity: 1,
    unitPrice: 0,
    attributes: {},
  };
}

function findSpec(
  itemType: ItemTypeDTO | undefined,
  key: string,
): ItemTypeAttributeDTO | undefined {
  return itemType?.attributeSchema.find((a) => a.key === key);
}

/**
 * Pass 5e — Dynamic create-order form.
 *
 * Universal flow:
 *   1. Pick an ItemType. Re-uses the per-tenant catalog the admin
 *      defines under /app/admin/item-types.
 *   2. Form renders the right attribute inputs from the type's
 *      attributeSchema. Add more lines (mixed types allowed).
 *   3. Customer block + currency + optional notes.
 *   4. If any chosen type has `requiresScheduling`, a scheduling block
 *      appears (single order-level window, since most B2C cart flows
 *      schedule one delivery / appointment / pickup per order).
 *
 * On submit posts `lineItems[]` to the polymorphic POST /api/orders
 * route (Pass 5d's createOrder). The legacy rental form is gone — the
 * auto-seeded `rental_booking` type is now just another option in the
 * picker.
 */
export function DynamicOrderForm({
  itemTypes,
  catalogItems = [],
  defaultCurrency,
  allowedCurrencies,
}: DynamicOrderFormProps) {
  const router = useRouter();
  const byKey = useMemo(() => {
    const m = new Map<string, ItemTypeDTO>();
    for (const t of itemTypes) m.set(t.key, t);
    return m;
  }, [itemTypes]);
  const itemsByTypeKey = useMemo(() => {
    const m = new Map<string, ItemDTO[]>();
    for (const it of catalogItems) {
      if (!m.has(it.itemTypeKey)) m.set(it.itemTypeKey, []);
      m.get(it.itemTypeKey)!.push(it);
    }
    return m;
  }, [catalogItems]);
  const itemById = useMemo(() => {
    const m = new Map<string, ItemDTO>();
    for (const it of catalogItems) m.set(it.id, it);
    return m;
  }, [catalogItems]);

  const [customer, setCustomer] = useState({
    name: "",
    email: "",
    phone: "",
  });
  // Pass 6d — remember the last email we ran the saved-customer lookup
  // for, so tabbing in/out of the email field doesn't re-fire the API
  // call when the value hasn't actually changed.
  const lastLookupEmail = useRef<string>("");

  async function lookupCustomerForEmail(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    if (email === lastLookupEmail.current) return;
    lastLookupEmail.current = email;
    try {
      const { customer: found } = await api.get<{
        customer: { name: string; phone: string } | null;
      }>(`/api/customers/lookup?email=${encodeURIComponent(email)}`);
      if (!found) return;
      setCustomer((c) => {
        const next = { ...c };
        let filled = false;
        if (!c.name.trim()) {
          next.name = found.name;
          filled = true;
        }
        if (!c.phone.trim()) {
          next.phone = found.phone;
          filled = true;
        }
        if (filled) {
          toast.success("Pre-filled from your last order with this email");
        }
        return next;
      });
    } catch {
      // Silent — prefill is a nicety, never block the form on it.
    }
  }
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [scheduling, setScheduling] = useState<SchedulingDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresScheduling = lines.some(
    (l) => byKey.get(l.itemTypeKey)?.requiresScheduling,
  );

  /** Default scheduling window: tomorrow → day after. Generated lazily
   *  in event handlers (NOT during render) so the render function
   *  stays pure under React 19's purity rule. */
  function defaultScheduling(): SchedulingDraft {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(Date.now() + 2 * 86_400_000);
    return {
      type: SchedulingType.FIXED_WINDOW,
      startsAt: toLocalInput(start),
      endsAt: toLocalInput(end),
    };
  }

  const grandTotal = lines.reduce(
    (sum, l) => sum + l.quantity * l.unitPrice,
    0,
  );

  function addLine(itemTypeKey: string): void {
    const t = byKey.get(itemTypeKey);
    if (!t) return;
    setLines((prev) => [...prev, newLine(t)]);
    // Lazy-init the scheduling window when the first scheduling-
    // required line lands. Replaces a render-side mutation block that
    // tripped React 19's purity rule.
    if (t.requiresScheduling && scheduling === null) {
      setScheduling(defaultScheduling());
    }
  }

  /** Pass 6c — pre-fill a line from a catalog Item row. Carries
   *  itemId back-pointer so the persisted order line can link to the
   *  catalog entry. */
  function addLineFromCatalogItem(itemId: string): void {
    const it = itemById.get(itemId);
    if (!it) return;
    const t = byKey.get(it.itemTypeKey);
    if (!t) return;
    setLines((prev) => [
      ...prev,
      {
        localId:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
        itemTypeKey: it.itemTypeKey,
        itemId: it.id,
        name: it.name,
        description: it.description ?? "",
        quantity: 1,
        unitPrice: it.basePrice?.amount ?? 0,
        attributes: { ...(it.attributes ?? {}) },
      },
    ]);
    if (t.requiresScheduling && scheduling === null) {
      setScheduling(defaultScheduling());
    }
  }

  function updateLine(localId: string, patch: Partial<LineDraft>): void {
    setLines((prev) =>
      prev.map((l) => (l.localId === localId ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(localId: string): void {
    setLines((prev) => {
      const next = prev.filter((l) => l.localId !== localId);
      const stillNeedsScheduling = next.some(
        (l) => byKey.get(l.itemTypeKey)?.requiresScheduling,
      );
      if (!stillNeedsScheduling && scheduling !== null) {
        setScheduling(null);
      }
      return next;
    });
  }

  function updateLineAttribute(
    localId: string,
    key: string,
    value: unknown,
  ): void {
    setLines((prev) =>
      prev.map((l) =>
        l.localId === localId
          ? { ...l, attributes: { ...l.attributes, [key]: value } }
          : l,
      ),
    );
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (lines.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    setSubmitting(true);
    const payload = {
      customer,
      lineItems: lines.map((l) => {
        const t = byKey.get(l.itemTypeKey);
        const attributes: Record<string, unknown> = {};
        for (const spec of t?.attributeSchema ?? []) {
          const raw = l.attributes[spec.key];
          if (raw === undefined || raw === null || raw === "") continue;
          // Coerce datetime-local inputs to ISO before send.
          if (spec.type === "DATE" && typeof raw === "string") {
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) {
              attributes[spec.key] = d.toISOString();
              continue;
            }
          }
          attributes[spec.key] = raw;
        }
        return {
          itemTypeKey: l.itemTypeKey,
          itemId: l.itemId ?? null,
          name: l.name,
          description: l.description.trim() || null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          total: l.quantity * l.unitPrice,
          attributes,
        };
      }),
      pricing: { amount: grandTotal, currency },
      scheduling: scheduling
        ? {
            type: scheduling.type,
            startsAt: new Date(scheduling.startsAt).toISOString(),
            endsAt:
              scheduling.endsAt && scheduling.type !== SchedulingType.OPEN_ENDED
                ? new Date(scheduling.endsAt).toISOString()
                : null,
          }
        : null,
      notes: notes.trim() || undefined,
    };
    try {
      const result = await api.post<{
        order: { id: string };
      }>("/api/orders", payload);
      toast.success("Order created");
      router.push(`/app/orders/${result.order.id}/email`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not create order",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (itemTypes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
        <p className="font-medium text-foreground">
          No item types defined for this organization yet.
        </p>
        <p className="mt-1">
          An admin needs to create at least one item type before orders can
          be entered.
        </p>
        <Button asChild className="mt-4" size="sm">
          <Link href="/app/admin/item-types/new">Create the first one</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}

      {/* ── Customer ───────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-[14px] font-semibold">Customer</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="cust-name">Name</Label>
            <Input
              id="cust-name"
              required
              value={customer.name}
              onChange={(e) =>
                setCustomer((c) => ({ ...c, name: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cust-email">Email</Label>
            <Input
              id="cust-email"
              type="email"
              required
              value={customer.email}
              onChange={(e) =>
                setCustomer((c) => ({ ...c, email: e.target.value }))
              }
              onBlur={(e) => {
                void lookupCustomerForEmail(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cust-phone">Phone</Label>
            <Input
              id="cust-phone"
              required
              value={customer.phone}
              onChange={(e) =>
                setCustomer((c) => ({ ...c, phone: e.target.value }))
              }
              placeholder="+1 555 0100"
            />
          </div>
        </div>
      </section>

      {/* ── Line items ─────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-[14px] font-semibold">Line items</h3>
          <div className="flex items-center gap-2">
            {catalogItems.length > 0 ? (
              <CatalogPicker
                items={catalogItems}
                onSelect={addLineFromCatalogItem}
              />
            ) : null}
            <ItemTypePicker
              itemTypes={itemTypes}
              onSelect={(key) => addLine(key)}
            />
          </div>
        </div>

        {lines.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            {catalogItems.length > 0
              ? "Pick from your catalog or add a new line by item type."
              : "Pick an item type above to add the first line."}
          </p>
        ) : null}

        {lines.map((line) => {
          const itemType = byKey.get(line.itemTypeKey);
          return (
            <div
              key={line.localId}
              className="space-y-3 rounded-md border border-border bg-card/40 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[11px]">
                      {getItemTypeDisplayName(itemType ?? null)}
                    </Badge>
                    {line.itemId ? (
                      <Badge variant="outline" className="text-[10.5px] gap-1">
                        <PackageIcon className="size-2.5" />
                        From catalog
                      </Badge>
                    ) : null}
                  </div>
                  {itemType ? (
                    <p className="text-[11.5px] text-muted-foreground mt-1">
                      {itemType.name}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLine(line.localId)}
                  aria-label="Remove line"
                >
                  <TrashIcon className="size-3.5" />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-[2fr_80px_120px]">
                <div className="space-y-1.5">
                  <Label htmlFor={`line-${line.localId}-name`}>Name</Label>
                  <Input
                    id={`line-${line.localId}-name`}
                    required
                    value={line.name}
                    onChange={(e) =>
                      updateLine(line.localId, { name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`line-${line.localId}-qty`}>Qty</Label>
                  <Input
                    id={`line-${line.localId}-qty`}
                    type="number"
                    min={1}
                    step="any"
                    required
                    value={line.quantity}
                    onChange={(e) =>
                      updateLine(line.localId, {
                        quantity: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`line-${line.localId}-price`}>
                    Unit price
                  </Label>
                  <Input
                    id={`line-${line.localId}-price`}
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    value={line.unitPrice}
                    onChange={(e) =>
                      updateLine(line.localId, {
                        unitPrice: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>

              {itemType && itemType.attributeSchema.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {[...itemType.attributeSchema]
                    .sort((a, b) => a.displayOrder - b.displayOrder)
                    .map((spec) => (
                      <AttributeField
                        key={spec.key}
                        spec={spec}
                        value={line.attributes[spec.key]}
                        onChange={(v) =>
                          updateLineAttribute(line.localId, spec.key, v)
                        }
                      />
                    ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {lines.length > 0 ? (
          <div className="flex items-center justify-end gap-3 border-t border-border pt-3 text-[13px]">
            <span className="text-muted-foreground">Grand total</span>
            <span className="font-semibold">
              {grandTotal.toFixed(2)} {currency}
            </span>
          </div>
        ) : null}
      </section>

      {/* ── Scheduling (conditional) ───────────────────────────────── */}
      {scheduling ? (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="text-[14px] font-semibold">Scheduling</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sched-type">Type</Label>
              <Select
                value={scheduling.type}
                onValueChange={(v) =>
                  setScheduling((s) =>
                    s ? { ...s, type: v as SchedulingType } : s,
                  )
                }
              >
                <SelectTrigger id="sched-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SchedulingType.FIXED_WINDOW}>
                    Fixed window
                  </SelectItem>
                  <SelectItem value={SchedulingType.OPEN_ENDED}>
                    Open-ended
                  </SelectItem>
                  <SelectItem value={SchedulingType.RECURRING_INTERVAL}>
                    Recurring
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-start">Starts</Label>
              <Input
                id="sched-start"
                type="datetime-local"
                required
                value={scheduling.startsAt}
                onChange={(e) =>
                  setScheduling((s) =>
                    s ? { ...s, startsAt: e.target.value } : s,
                  )
                }
              />
            </div>
            {scheduling.type !== SchedulingType.OPEN_ENDED ? (
              <div className="space-y-1.5">
                <Label htmlFor="sched-end">Ends</Label>
                <Input
                  id="sched-end"
                  type="datetime-local"
                  required
                  value={scheduling.endsAt}
                  onChange={(e) =>
                    setScheduling((s) =>
                      s ? { ...s, endsAt: e.target.value } : s,
                    )
                  }
                />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Pricing + Notes ────────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Select
            value={currency}
            onValueChange={(v) => setCurrency(v as Currency)}
          >
            <SelectTrigger id="currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedCurrencies.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notes">Internal notes (optional)</Label>
          <Textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
          />
        </div>
      </section>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/app/orders")}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || lines.length === 0}>
          Create order
        </Button>
      </div>
    </form>
  );
}

function CatalogPicker({
  items,
  onSelect,
}: {
  items: ItemDTO[];
  onSelect: (id: string) => void;
}) {
  const [value, setValue] = useState<string>("");
  // Group by itemTypeKey so a tenant who runs multiple verticals
  // sees their catalog organised, not as a flat list.
  const grouped = useMemo(() => {
    const m = new Map<string, ItemDTO[]>();
    for (const it of items) {
      if (!m.has(it.itemTypeKey)) m.set(it.itemTypeKey, []);
      m.get(it.itemTypeKey)!.push(it);
    }
    return [...m.entries()];
  }, [items]);

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onSelect(v);
        setValue("");
      }}
    >
      <SelectTrigger className="w-56">
        <PackageIcon className="size-3.5" />
        <SelectValue placeholder="Pick from catalog…" />
      </SelectTrigger>
      <SelectContent>
        {grouped.map(([typeKey, rows]) => (
          <div key={typeKey}>
            <div className="px-2 py-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              {typeKey}
            </div>
            {rows.map((it) => (
              <SelectItem key={it.id} value={it.id}>
                <span className="flex items-baseline gap-2">
                  <span>{it.name}</span>
                  {it.sku ? (
                    <span className="text-[11px] text-muted-foreground">
                      ({it.sku})
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

function ItemTypePicker({
  itemTypes,
  onSelect,
}: {
  itemTypes: ItemTypeDTO[];
  onSelect: (key: string) => void;
}) {
  const [value, setValue] = useState<string>("");
  return (
    <div className="flex items-center gap-2">
      <Select
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onSelect(v);
          setValue("");
        }}
      >
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Add item type…" />
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
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          if (itemTypes[0]) onSelect(itemTypes[0].key);
        }}
        disabled={itemTypes.length === 0}
      >
        <PlusIcon className="size-3.5" />
        First
      </Button>
    </div>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
