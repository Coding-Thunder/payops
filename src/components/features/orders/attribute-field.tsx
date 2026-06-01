"use client";

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
import { ItemAttributeType } from "@/lib/constants/items";
import type { ItemTypeAttributeDTO } from "@/server/services/item-type.service";

interface AttributeFieldProps {
  spec: ItemTypeAttributeDTO;
  value: unknown;
  onChange: (next: unknown) => void;
}

/**
 * Pass 5e, Renders one attribute input based on its spec. Used by the
 * dynamic create-order form to render whatever schema the selected
 * ItemType declares. Stays controlled, the parent owns the entire
 * attributes object.
 */
export function AttributeField({ spec, value, onChange }: AttributeFieldProps) {
  const id = `attr-${spec.key}`;
  const required = spec.required;
  const help = spec.helpText ?? null;

  let control: React.ReactNode;
  switch (spec.type) {
    case ItemAttributeType.STRING:
    case ItemAttributeType.URL:
      control = (
        <Input
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          type={spec.type === ItemAttributeType.URL ? "url" : "text"}
          placeholder={spec.type === ItemAttributeType.URL ? "https://" : undefined}
        />
      );
      break;
    case ItemAttributeType.NUMBER:
      control = (
        <Input
          id={id}
          type="number"
          step="any"
          value={
            typeof value === "number" || typeof value === "string" ? value : ""
          }
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? null : Number(v));
          }}
          required={required}
        />
      );
      break;
    case ItemAttributeType.DATE:
      control = (
        <Input
          id={id}
          type="datetime-local"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        />
      );
      break;
    case ItemAttributeType.BOOLEAN:
      control = (
        <label className="inline-flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(v) => onChange(v === true)}
          />
          <span className="text-[13px]">{spec.label}</span>
        </label>
      );
      break;
    case ItemAttributeType.SELECT:
      control = (
        <Select
          value={typeof value === "string" ? value : ""}
          onValueChange={onChange}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(spec.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      break;
    default:
      control = null;
  }

  // Boolean renders its own inline label.
  if (spec.type === ItemAttributeType.BOOLEAN) {
    return (
      <div className="space-y-1.5">
        {control}
        {help ? (
          <p className="text-[11.5px] text-muted-foreground">{help}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {spec.label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {control}
      {help ? (
        <p className="text-[11.5px] text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
