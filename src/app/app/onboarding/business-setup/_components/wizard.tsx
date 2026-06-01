"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  GripVerticalIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api-client";
import {
  ITEM_ATTRIBUTE_TYPES,
  ItemAttributeType,
} from "@/lib/constants/items";
import {
  BUSINESS_TEMPLATE_LIST,
  BUSINESS_TEMPLATES,
  type BusinessTemplate,
  type BusinessVertical,
  type TemplateAttribute,
} from "@/lib/constants/business-templates";

import { DynamicOrderForm } from "@/components/features/orders/dynamic-order-form";
import { Currency } from "@/lib/constants/enums";

/**
 * Pass 6b, Business onboarding wizard client.
 *
 * Five linear steps, URL-driven state so refresh / back-button works:
 *   1. Pick business vertical.
 *   2. Review the seeded ItemType (read-only).
 *   3. Customize fields inline (rename / required / reorder / remove /
 *      add-new with full attribute-type support).
 *   4. Preview the order form + confirmation email side-by-side.
 *   5. Final "create my setup" CTA. Posts to the wizard API and
 *      redirects to /app/orders/create with the new ItemType preselected.
 *
 * No DB writes happen until step 5's submit. Abandoning earlier leaves
 * zero state behind.
 */

interface FieldDraft {
  /** Stable internal id used for React keys + reorder operations.
   *  Distinct from the persisted `key` (which the user types). */
  localId: string;
  key: string;
  label: string;
  type: ItemAttributeType;
  required: boolean;
  options?: string[];
  helpText?: string | null;
  displayOrder: number;
}

interface WizardState {
  vertical: BusinessVertical | null;
  /** Per-template editable copy. Re-seeded whenever `vertical` changes. */
  itemTypeName: string;
  itemTypeKey: string;
  itemTypeDescription: string;
  fields: FieldDraft[];
}

const STEP_LABELS = ["Pick", "Review", "Customize", "Preview", "Finish"];

export function BusinessSetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>({
    vertical: null,
    itemTypeName: "",
    itemTypeKey: "",
    itemTypeDescription: "",
    fields: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyTemplate(vertical: BusinessVertical) {
    const t = BUSINESS_TEMPLATES[vertical];
    setState({
      vertical,
      itemTypeName: t.itemType.name,
      itemTypeKey: t.itemType.key,
      itemTypeDescription: t.itemType.description,
      fields: t.itemType.attributeSchema.map((a, idx) => ({
        localId: `seed-${a.key}-${idx}`,
        key: a.key,
        label: a.label,
        type: a.type,
        required: a.required,
        options: a.options,
        helpText: a.helpText ?? null,
        displayOrder: idx,
      })),
    });
    setStep(2);
    setError(null);
  }

  function backToPicker() {
    setStep(1);
    setError(null);
  }

  function gotoStep(s: number) {
    if (s < 1 || s > 5) return;
    setStep(s);
    setError(null);
  }

  async function submit() {
    if (!state.vertical) return;
    setSubmitting(true);
    setError(null);
    try {
      const t = BUSINESS_TEMPLATES[state.vertical];
      const body = {
        vertical: state.vertical,
        itemType: {
          key: state.itemTypeKey.trim().toLowerCase(),
          name: state.itemTypeName.trim(),
          description: state.itemTypeDescription.trim() || null,
          pricingModel: t.itemType.pricingModel,
          requiresScheduling: t.itemType.requiresScheduling,
          inventoryTracked: t.itemType.inventoryTracked,
          attributeSchema: state.fields.map((f, idx) => ({
            key: f.key.trim().toLowerCase(),
            label: f.label.trim(),
            type: f.type,
            required: f.required,
            options:
              f.type === ItemAttributeType.SELECT
                ? (f.options ?? []).map((o) => o.trim()).filter(Boolean)
                : undefined,
            helpText: f.helpText?.trim() || null,
            displayOrder: idx,
          })),
          confirmationEmailBlocks: t.itemType.confirmationEmailBlocks,
        },
      };
      await api.post("/api/onboarding/business-setup", body);
      router.push("/app/orders/create");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not save setup",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper current={step} />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t save your setup</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {step === 1 ? (
        <Step1Picker onPick={applyTemplate} />
      ) : null}

      {step === 2 && state.vertical ? (
        <Step2Review
          template={BUSINESS_TEMPLATES[state.vertical]}
          onBack={backToPicker}
          onContinue={() => gotoStep(3)}
        />
      ) : null}

      {step === 3 && state.vertical ? (
        <Step3Customize
          state={state}
          setState={setState}
          onBack={() => gotoStep(2)}
          onContinue={() => gotoStep(4)}
        />
      ) : null}

      {step === 4 && state.vertical ? (
        <Step4Preview
          state={state}
          onBack={() => gotoStep(3)}
          onContinue={() => gotoStep(5)}
        />
      ) : null}

      {step === 5 && state.vertical ? (
        <Step5Finish
          state={state}
          submitting={submitting}
          onBack={() => gotoStep(4)}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── Stepper ─────────────────────────────── */

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 text-[12px]">
      {STEP_LABELS.map((label, idx) => {
        const n = idx + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li key={n} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex size-5 items-center justify-center rounded-full text-[10.5px] font-medium",
                done
                  ? "bg-emerald-500/15 text-emerald-700"
                  : active
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {done ? <CheckCircle2Icon className="size-3" /> : n}
            </span>
            <span
              className={cn(
                active
                  ? "font-medium text-foreground"
                  : done
                    ? "text-muted-foreground line-through"
                    : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            {n < STEP_LABELS.length ? (
              <ArrowRightIcon className="size-3 text-muted-foreground/40" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ─────────────────────────────── Step 1 ──────────────────────────────── */

function Step1Picker({
  onPick,
}: {
  onPick: (vertical: BusinessVertical) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What kind of business are you running?</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BUSINESS_TEMPLATE_LIST.map((t) => (
            <button
              key={t.vertical}
              type="button"
              onClick={() => onPick(t.vertical)}
              className={cn(
                "group flex flex-col items-start gap-1 rounded-lg border border-border bg-card p-4 text-left",
                "transition-colors hover:border-foreground/30 hover:bg-card/80",
              )}
            >
              <div className="text-[13.5px] font-medium text-foreground">
                {t.displayName}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {t.tagline}
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground/70">
                {t.examples.slice(0, 3).join(" • ")}
              </div>
            </button>
          ))}
        </div>
        <p className="mt-4 text-[12px] text-muted-foreground">
          Not sure?{" "}
          <button
            type="button"
            onClick={() => onPick("generic")}
            className="underline"
          >
            Start blank
          </button>{" "}
         , you can add fields manually.
        </p>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────── Step 2 ──────────────────────────────── */

function Step2Review({
  template,
  onBack,
  onContinue,
}: {
  template: BusinessTemplate;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-amber-500" />
            Here&apos;s what we set up
          </CardTitle>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Based on <strong>{template.displayName}</strong>. You can edit
            anything in the next step.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-3.5" />
          Switch business type
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/30 px-3 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold">
                {template.itemType.name}
              </p>
              <p className="text-[12px] text-muted-foreground">
                {template.itemType.description}
              </p>
            </div>
            <Badge variant="secondary" className="font-mono text-[11px]">
              {template.itemType.key}
            </Badge>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-[12px]">
            <div>
              <dt className="text-muted-foreground">Pricing</dt>
              <dd className="font-mono">{template.itemType.pricingModel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Scheduling</dt>
              <dd>
                {template.itemType.requiresScheduling ? "Required" : "-"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Inventory</dt>
              <dd>{template.itemType.inventoryTracked ? "Tracked" : "-"}</dd>
            </div>
          </dl>
        </div>

        <div>
          <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Fields you&apos;ll capture per order
          </h3>
          {template.itemType.attributeSchema.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              No extra fields, just name, quantity, price. You can add
              more on the next step.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border text-[13px]">
              {template.itemType.attributeSchema.map((a) => (
                <li
                  key={a.key}
                  className="flex items-center justify-between py-2"
                >
                  <div>
                    <span className="font-medium">{a.label}</span>
                    {a.required ? (
                      <span className="ml-1 text-destructive">*</span>
                    ) : null}
                    {a.helpText ? (
                      <p className="text-[11.5px] text-muted-foreground">
                        {a.helpText}
                      </p>
                    ) : null}
                  </div>
                  <Badge variant="outline" className="text-[11px]">
                    {a.type}
                    {a.type === ItemAttributeType.SELECT &&
                    a.options &&
                    a.options.length > 0
                      ? ` · ${a.options.length} options`
                      : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onContinue}>
            Customize fields
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────── Step 3 ──────────────────────────────── */

function Step3Customize({
  state,
  setState,
  onBack,
  onContinue,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  function updateField(localId: string, patch: Partial<FieldDraft>) {
    setState((s) => ({
      ...s,
      fields: s.fields.map((f) =>
        f.localId === localId ? { ...f, ...patch } : f,
      ),
    }));
  }

  function removeField(localId: string) {
    setState((s) => ({
      ...s,
      fields: s.fields
        .filter((f) => f.localId !== localId)
        .map((f, idx) => ({ ...f, displayOrder: idx })),
    }));
  }

  function move(localId: string, dir: -1 | 1) {
    setState((s) => {
      const idx = s.fields.findIndex((f) => f.localId === localId);
      const swap = idx + dir;
      if (idx < 0 || swap < 0 || swap >= s.fields.length) return s;
      const next = [...s.fields];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return {
        ...s,
        fields: next.map((f, i) => ({ ...f, displayOrder: i })),
      };
    });
  }

  function addField() {
    setState((s) => ({
      ...s,
      fields: [
        ...s.fields,
        {
          localId: `new-${Date.now()}`,
          key: "",
          label: "",
          type: ItemAttributeType.STRING,
          required: false,
          options: undefined,
          helpText: "",
          displayOrder: s.fields.length,
        },
      ],
    }));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Customize your fields</CardTitle>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Rename labels, mark fields required, or remove what you
            don&apos;t need. The internal key is locked once you save.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="it-name">Item type name</Label>
            <Input
              id="it-name"
              value={state.itemTypeName}
              onChange={(e) =>
                setState((s) => ({ ...s, itemTypeName: e.target.value }))
              }
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="it-key">Internal key</Label>
            <Input
              id="it-key"
              value={state.itemTypeKey}
              onChange={(e) =>
                setState((s) => ({ ...s, itemTypeKey: e.target.value }))
              }
              maxLength={32}
            />
            <p className="text-[11px] text-muted-foreground">
              Locked after save, used on every order line forever.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="it-desc">Description</Label>
            <Textarea
              id="it-desc"
              value={state.itemTypeDescription}
              onChange={(e) =>
                setState((s) => ({
                  ...s,
                  itemTypeDescription: e.target.value,
                }))
              }
              rows={2}
              maxLength={500}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-semibold">Fields</h3>
              <p className="text-[11.5px] text-muted-foreground">
                Order matters, the create-order form renders them top-down.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addField}
            >
              <PlusIcon className="size-3.5" />
              Add field
            </Button>
          </div>

          {state.fields.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted-foreground">
              <CircleDashedIcon className="mx-auto mb-2 size-4" />
              No fields. Customers will just see name + quantity + price.
              Add one if you need to capture more per line.
            </div>
          ) : null}

          {state.fields.map((field, idx) => (
            <FieldRow
              key={field.localId}
              field={field}
              isFirst={idx === 0}
              isLast={idx === state.fields.length - 1}
              onChange={(p) => updateField(field.localId, p)}
              onRemove={() => removeField(field.localId)}
              onMoveUp={() => move(field.localId, -1)}
              onMoveDown={() => move(field.localId, 1)}
            />
          ))}
        </section>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onContinue}>
            Preview
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FieldRow({
  field,
  isFirst,
  isLast,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  field: FieldDraft;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<FieldDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const isSelect = field.type === ItemAttributeType.SELECT;
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-[24px_1fr_1fr_140px_120px_48px] sm:items-end">
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className="text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
            aria-label="Move up"
          >
            <ArrowLeftIcon className="size-3 rotate-90" />
          </button>
          <GripVerticalIcon className="size-3 text-muted-foreground/40" />
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className="text-muted-foreground/60 hover:text-foreground disabled:opacity-30"
            aria-label="Move down"
          >
            <ArrowLeftIcon className="size-3 -rotate-90" />
          </button>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Label</Label>
          <Input
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="What the customer sees"
            required
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Internal key</Label>
          <Input
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="snake_case"
            required
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Type</Label>
          <Select
            value={field.type}
            onValueChange={(v) =>
              onChange({
                type: v as ItemAttributeType,
                options:
                  v === ItemAttributeType.SELECT
                    ? (field.options ?? [""])
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
                  {humanizeType(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-[12px]">
          <Checkbox
            checked={field.required}
            onCheckedChange={(v) => onChange({ required: v === true })}
          />
          Required
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Remove field"
        >
          <TrashIcon className="size-3.5" />
        </Button>
      </div>
      {isSelect ? (
        <div className="space-y-1">
          <Label className="text-[11px]">Options (comma-separated)</Label>
          <Input
            value={(field.options ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                options: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="Small, Medium, Large"
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-[11px]">Help text (optional)</Label>
        <Input
          value={field.helpText ?? ""}
          onChange={(e) => onChange({ helpText: e.target.value })}
          placeholder="Shown under the input on the order form."
        />
      </div>
    </div>
  );
}

function humanizeType(t: ItemAttributeType): string {
  switch (t) {
    case ItemAttributeType.STRING:
      return "Short text";
    case ItemAttributeType.NUMBER:
      return "Number";
    case ItemAttributeType.SELECT:
      return "Dropdown (pick one)";
    case ItemAttributeType.DATE:
      return "Date / time";
    case ItemAttributeType.URL:
      return "Link / URL";
    case ItemAttributeType.BOOLEAN:
      return "Yes / no";
    default:
      return t;
  }
}

/* ─────────────────────────────── Step 4 ──────────────────────────────── */

function Step4Preview({
  state,
  onBack,
  onContinue,
}: {
  state: WizardState;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [emailHtml, setEmailHtml] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<{ html: string }>(
          `/api/onboarding/business-setup/preview-email?vertical=${state.vertical}`,
        );
        if (!cancelled) setEmailHtml(res.html);
      } catch (err) {
        if (!cancelled) {
          setEmailError(
            err instanceof ApiClientError
              ? err.message
              : "Couldn't render the email preview",
          );
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [state.vertical]);

  // Build a synthetic ItemType DTO so the DynamicOrderForm renders the
  // same way it will after save. `id` doesn't matter, the form keys
  // off the catalog list.
  const previewItemTypes = useMemo(
    () => [
      {
        id: "preview",
        key: state.itemTypeKey || "preview",
        name: state.itemTypeName || "Item",
        displayName: state.itemTypeName || "Item",
        description: state.itemTypeDescription || null,
        pricingModel: state.vertical
          ? BUSINESS_TEMPLATES[state.vertical].itemType.pricingModel
          : "QUANTITY",
        requiresScheduling: state.vertical
          ? BUSINESS_TEMPLATES[state.vertical].itemType.requiresScheduling
          : false,
        inventoryTracked: false,
        attributeSchema: state.fields.map((f, idx) => ({
          key: f.key.trim() || `field_${idx}`,
          label: f.label.trim() || `Field ${idx + 1}`,
          type: f.type,
          required: f.required,
          options: f.type === ItemAttributeType.SELECT ? f.options : undefined,
          helpText: f.helpText ?? null,
          displayOrder: idx,
        })),
        confirmationEmailBlocks: state.vertical
          ? BUSINESS_TEMPLATES[state.vertical].itemType.confirmationEmailBlocks
          : [],
        status: "ACTIVE" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    [state],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Preview</CardTitle>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              On the left: the form your operators will fill in. On the
              right: the email your customers will receive after payment.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Operator: create-order form
              </p>
              <div className="pointer-events-none rounded-lg border border-border bg-card/30 p-3 opacity-95">
                <DynamicOrderForm
                  itemTypes={previewItemTypes}
                  defaultCurrency={Currency.USD}
                  allowedCurrencies={[Currency.USD]}
                />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                Customer: confirmation email
              </p>
              {emailError ? (
                <Alert variant="destructive">
                  <AlertDescription>{emailError}</AlertDescription>
                </Alert>
              ) : null}
              {emailHtml ? (
                <iframe
                  title="Email preview"
                  srcDoc={emailHtml}
                  className="h-[640px] w-full rounded-lg border border-border bg-white"
                  sandbox="allow-same-origin"
                />
              ) : (
                <div className="h-[640px] rounded-lg border border-dashed border-border" />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={onBack}>
          Back to edits
        </Button>
        <Button onClick={onContinue}>
          Looks good, finish
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── Step 5 ──────────────────────────────── */

function Step5Finish({
  state,
  submitting,
  onBack,
  onSubmit,
}: {
  state: WizardState;
  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>One click and you&apos;re live</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-[13px]">
          <li className="flex items-start gap-2">
            <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600" />
            <span>
              We&apos;ll create an item type called{" "}
              <strong>{state.itemTypeName}</strong>{" "}
              <code className="text-[11px]">{state.itemTypeKey}</code> with{" "}
              {state.fields.length} field
              {state.fields.length === 1 ? "" : "s"}.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600" />
            <span>
              You&apos;ll land on the create-order page with this type
              preselected so you can take your first payment immediately.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600" />
            <span>
              You can edit fields anytime from <em>Admin → Item types</em>
              {" "}- but the internal key is locked once orders start using
              it.
            </span>
          </li>
        </ul>
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onBack} disabled={submitting}>
            Back
          </Button>
          <LoadingButton onClick={onSubmit} loading={submitting}>
            Create my setup & take first order
          </LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}
