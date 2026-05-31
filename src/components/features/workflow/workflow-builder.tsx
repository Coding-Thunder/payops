"use client";

import { useState } from "react";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  CoinsIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import type { WorkflowDTO, WorkflowStatusDTO } from "@/types/workflow";

/**
 * Workflow builder — tenant edits the order lifecycle.
 *
 * Three regions:
 *
 *   1. Statuses — list with edit (label/color/flags) + delete.
 *      Service refuses deletes for load-bearing statuses; we surface
 *      that as a toast.
 *   2. Transitions — list (read-only labels) + add form + delete.
 *      No edit-in-place; if an operator wants different copy on a
 *      transition they delete + re-add. Keeps the UI simple.
 *   3. Payment mapping — two dropdowns: which status the Stripe
 *      success / failure webhook lands on. Save submits both at once
 *      since the service enforces them together.
 *
 * All actions optimistic-update the local workflow state; on error,
 * the server response is rolled back via re-fetch (next router refresh).
 */

interface WorkflowBuilderProps {
  initial: WorkflowDTO;
  canEdit: boolean;
}

export function WorkflowBuilder({ initial, canEdit }: WorkflowBuilderProps) {
  const [workflow, setWorkflow] = useState<WorkflowDTO>(initial);

  return (
    <div className="space-y-6">
      <StatusesPanel
        workflow={workflow}
        canEdit={canEdit}
        onChange={setWorkflow}
      />
      <TransitionsPanel
        workflow={workflow}
        canEdit={canEdit}
        onChange={setWorkflow}
      />
      <PaymentMappingPanel
        workflow={workflow}
        canEdit={canEdit}
        onChange={setWorkflow}
      />
    </div>
  );
}

/* ───────────────────────────── Statuses ────────────────────────────────── */

function StatusesPanel({
  workflow,
  canEdit,
  onChange,
}: {
  workflow: WorkflowDTO;
  canEdit: boolean;
  onChange: (next: WorkflowDTO) => void;
}) {
  const [adding, setAdding] = useState(false);

  const sorted = [...workflow.statuses].sort(
    (a, b) => a.displayOrder - b.displayOrder,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Statuses ({sorted.length})</CardTitle>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding((v) => !v)}
            className="gap-1.5"
          >
            <PlusIcon className="size-3.5" />
            {adding ? "Cancel" : "Add status"}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <AddStatusForm
            workflow={workflow}
            onAdded={(next) => {
              onChange(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}

        <ul className="divide-y rounded-md border">
          {sorted.map((s) => (
            <StatusRow
              key={s.key}
              status={s}
              workflow={workflow}
              canEdit={canEdit}
              onChange={onChange}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function StatusRow({
  status,
  workflow,
  canEdit,
  onChange,
}: {
  status: WorkflowStatusDTO;
  workflow: WorkflowDTO;
  canEdit: boolean;
  onChange: (next: WorkflowDTO) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(status.label);
  const [color, setColor] = useState(status.color);
  const [isTerminal, setIsTerminal] = useState(status.isTerminal);
  const [isPaid, setIsPaid] = useState(status.isPaid);

  const isLoadBearing =
    workflow.initialStatusKey === status.key ||
    workflow.paymentSuccessStatusKey === status.key ||
    workflow.paymentFailureStatusKey === status.key;

  async function saveEdit() {
    setBusy(true);
    try {
      const { workflow: next } = await api.patch<{ workflow: WorkflowDTO }>(
        `/api/admin/workflow/statuses/${encodeURIComponent(status.key)}`,
        { label, color, isTerminal, isPaid },
      );
      onChange(next);
      setEditing(false);
      toast.success(`Updated "${status.key}"`);
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not update status",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteStatus() {
    if (
      !confirm(
        `Delete status "${status.key}"? Orders currently in this status will keep their value but won't match any defined transitions.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const { workflow: next } = await api.del<{ workflow: WorkflowDTO }>(
        `/api/admin/workflow/statuses/${encodeURIComponent(status.key)}`,
      );
      onChange(next);
      toast.success(`Deleted "${status.key}"`);
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not delete status",
      );
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="space-y-3 p-3.5 bg-muted/30">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor={`label-${status.key}`} className="text-[11px]">
              Label
            </Label>
            <Input
              id={`label-${status.key}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`color-${status.key}`} className="text-[11px]">
              Color
            </Label>
            <div className="flex items-center gap-2">
              <input
                id={`color-${status.key}`}
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value.toUpperCase())}
                disabled={busy}
                className="h-9 w-12 cursor-pointer rounded border"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                maxLength={7}
                disabled={busy}
                className="w-24 font-mono text-[12px]"
              />
            </div>
          </div>
        </div>
        <div className="flex gap-4 text-[12.5px]">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isTerminal}
              onChange={(e) => setIsTerminal(e.target.checked)}
              disabled={busy}
            />
            Terminal
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isPaid}
              onChange={(e) => setIsPaid(e.target.checked)}
              disabled={busy}
            />
            Counts as paid
          </label>
        </div>
        <div className="flex gap-2">
          <LoadingButton
            size="sm"
            onClick={saveEdit}
            loading={busy}
            loadingText="Saving"
          >
            Save
          </LoadingButton>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(false)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 p-3.5">
      <span
        aria-hidden
        className="inline-block size-3 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[13px]">{status.label}</span>
          <code className="text-[11px] text-muted-foreground font-mono">
            {status.key}
          </code>
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {workflow.initialStatusKey === status.key ? (
            <Badge variant="outline" className="gap-1 text-[10.5px]">
              <CircleDotIcon className="size-2.5" /> Initial
            </Badge>
          ) : null}
          {status.isTerminal ? (
            <Badge variant="outline" className="gap-1 text-[10.5px]">
              <CircleIcon className="size-2.5" /> Terminal
            </Badge>
          ) : null}
          {status.isPaid ? (
            <Badge variant="outline" className="gap-1 text-[10.5px]">
              <CoinsIcon className="size-2.5" /> Paid
            </Badge>
          ) : null}
          {workflow.paymentSuccessStatusKey === status.key ? (
            <Badge variant="default" className="gap-1 text-[10.5px]">
              <CheckCircle2Icon className="size-2.5" /> Stripe success target
            </Badge>
          ) : null}
          {workflow.paymentFailureStatusKey === status.key ? (
            <Badge variant="destructive" className="gap-1 text-[10.5px]">
              Stripe failure target
            </Badge>
          ) : null}
        </div>
      </div>
      {canEdit ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={deleteStatus}
            disabled={busy || isLoadBearing}
            title={
              isLoadBearing
                ? "Load-bearing status — re-point payment mappings or initial-status before deleting"
                : undefined
            }
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function AddStatusForm({
  workflow,
  onAdded,
  onCancel,
}: {
  workflow: WorkflowDTO;
  onAdded: (next: WorkflowDTO) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#6B7280");
  const [isTerminal, setIsTerminal] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const { workflow: next } = await api.post<{ workflow: WorkflowDTO }>(
        "/api/admin/workflow/statuses",
        {
          key: key.toUpperCase(),
          label,
          color,
          isTerminal,
          isPaid,
        },
      );
      onAdded(next);
      toast.success(`Added "${key.toUpperCase()}"`);
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not add status",
      );
    } finally {
      setBusy(false);
    }
  }

  // Inline preview of the key so the operator knows the casing rule.
  const previewKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const duplicates = workflow.statuses.some((s) => s.key === previewKey);

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px]">Status key</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="SHIPPED"
            maxLength={48}
            disabled={busy}
            className="font-mono"
          />
          {previewKey ? (
            <p className="text-[11px] text-muted-foreground">
              Will save as: <code className="font-mono">{previewKey}</code>
              {duplicates ? (
                <span className="ml-1 text-destructive">· already exists</span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px]">Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Shipped"
            maxLength={80}
            disabled={busy}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-[11px]">Color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value.toUpperCase())}
              disabled={busy}
              className="h-9 w-12 cursor-pointer rounded border"
            />
            <Input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              maxLength={7}
              disabled={busy}
              className="w-24 font-mono text-[12px]"
            />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <input
            type="checkbox"
            checked={isTerminal}
            onChange={(e) => setIsTerminal(e.target.checked)}
            disabled={busy}
          />
          Terminal
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <input
            type="checkbox"
            checked={isPaid}
            onChange={(e) => setIsPaid(e.target.checked)}
            disabled={busy}
          />
          Counts as paid
        </label>
      </div>
      <div className="flex gap-2">
        <LoadingButton
          size="sm"
          onClick={submit}
          loading={busy}
          loadingText="Saving"
          disabled={!previewKey || !label.trim() || duplicates}
        >
          Add status
        </LoadingButton>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Transitions ─────────────────────────────── */

function TransitionsPanel({
  workflow,
  canEdit,
  onChange,
}: {
  workflow: WorkflowDTO;
  canEdit: boolean;
  onChange: (next: WorkflowDTO) => void;
}) {
  const [adding, setAdding] = useState(false);

  const statusByKey = new Map(workflow.statuses.map((s) => [s.key, s]));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Transitions ({workflow.transitions.length})</CardTitle>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding((v) => !v)}
            className="gap-1.5"
          >
            <PlusIcon className="size-3.5" />
            {adding ? "Cancel" : "Add transition"}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <AddTransitionForm
            workflow={workflow}
            onAdded={(next) => {
              onChange(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}

        {workflow.transitions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground italic">
            No transitions defined yet. Add one above to let agents move
            orders between statuses.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {workflow.transitions.map((t) => {
              const from = statusByKey.get(t.fromKey);
              const to = statusByKey.get(t.toKey);
              return (
                <li
                  key={t.id}
                  className="flex items-center gap-3 p-3.5"
                >
                  <StatusChip
                    label={from?.label ?? t.fromKey}
                    color={from?.color}
                  />
                  <span className="text-muted-foreground">→</span>
                  <StatusChip
                    label={to?.label ?? t.toKey}
                    color={to?.color}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[13px]">{t.label}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                      {t.requiredPermission ? (
                        <span>
                          requires{" "}
                          <code className="font-mono">
                            {t.requiredPermission}
                          </code>
                        </span>
                      ) : null}
                      {t.automationTriggerKey ? (
                        <span>
                          trigger{" "}
                          <code className="font-mono">
                            {t.automationTriggerKey}
                          </code>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {canEdit ? (
                    <DeleteTransitionButton
                      transitionId={t.id}
                      onChange={onChange}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusChip({
  label,
  color,
}: {
  label: string;
  color: string | undefined;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border bg-background px-2 py-0.5 text-[12px]">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: color ?? "#6B7280" }}
      />
      {label}
    </span>
  );
}

function DeleteTransitionButton({
  transitionId,
  onChange,
}: {
  transitionId: string;
  onChange: (next: WorkflowDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!confirm("Delete this transition?")) return;
    setBusy(true);
    try {
      const { workflow: next } = await api.del<{ workflow: WorkflowDTO }>(
        `/api/admin/workflow/transitions/${encodeURIComponent(transitionId)}`,
      );
      onChange(next);
      toast.success("Transition deleted");
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not delete",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="ghost" size="sm" onClick={del} disabled={busy}>
      <Trash2Icon className="size-3.5" />
    </Button>
  );
}

function AddTransitionForm({
  workflow,
  onAdded,
  onCancel,
}: {
  workflow: WorkflowDTO;
  onAdded: (next: WorkflowDTO) => void;
  onCancel: () => void;
}) {
  const [fromKey, setFromKey] = useState("");
  const [toKey, setToKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const { workflow: next } = await api.post<{ workflow: WorkflowDTO }>(
        "/api/admin/workflow/transitions",
        { fromKey, toKey, label },
      );
      onAdded(next);
      toast.success("Transition added");
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not add",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1.5fr]">
        <div className="space-y-1.5">
          <Label className="text-[11px]">From</Label>
          <Select value={fromKey} onValueChange={setFromKey} disabled={busy}>
            <SelectTrigger>
              <SelectValue placeholder="Pick…" />
            </SelectTrigger>
            <SelectContent>
              {workflow.statuses.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px]">To</Label>
          <Select value={toKey} onValueChange={setToKey} disabled={busy}>
            <SelectTrigger>
              <SelectValue placeholder="Pick…" />
            </SelectTrigger>
            <SelectContent>
              {workflow.statuses.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px]">Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Mark shipped"
            maxLength={80}
            disabled={busy}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <LoadingButton
          size="sm"
          onClick={submit}
          loading={busy}
          loadingText="Saving"
          disabled={!fromKey || !toKey || !label.trim() || fromKey === toKey}
        >
          Add transition
        </LoadingButton>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────── Payment mapping ───────────────────────────────── */

function PaymentMappingPanel({
  workflow,
  canEdit,
  onChange,
}: {
  workflow: WorkflowDTO;
  canEdit: boolean;
  onChange: (next: WorkflowDTO) => void;
}) {
  const [successKey, setSuccessKey] = useState(workflow.paymentSuccessStatusKey);
  const [failureKey, setFailureKey] = useState(workflow.paymentFailureStatusKey);
  const [busy, setBusy] = useState(false);

  const paidStatuses = workflow.statuses.filter((s) => s.isPaid);
  const dirty =
    successKey !== workflow.paymentSuccessStatusKey ||
    failureKey !== workflow.paymentFailureStatusKey;

  async function save() {
    setBusy(true);
    try {
      const { workflow: next } = await api.patch<{ workflow: WorkflowDTO }>(
        "/api/admin/workflow/payment-mapping",
        {
          paymentSuccessStatusKey: successKey,
          paymentFailureStatusKey: failureKey,
        },
      );
      onChange(next);
      toast.success("Payment mapping updated");
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Could not save mapping",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stripe payment mapping</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription>
            When a Stripe webhook reports a successful checkout, the order
            flips to the success status below. Same for failures. Re-point
            these after renaming any status that Stripe writes into.
            <br />
            <strong>Success target must have the &quot;Counts as paid&quot; flag set</strong>{" "}
            so the dashboard&apos;s revenue rollup includes those orders.
          </AlertDescription>
        </Alert>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[11px]">Payment success target</Label>
            <Select
              value={successKey}
              onValueChange={setSuccessKey}
              disabled={!canEdit || busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paidStatuses.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                    No paid statuses available — flag one with &quot;Counts
                    as paid&quot; first.
                  </div>
                ) : (
                  paidStatuses.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label} ({s.key})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px]">Payment failure target</Label>
            <Select
              value={failureKey}
              onValueChange={setFailureKey}
              disabled={!canEdit || busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workflow.statuses.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label} ({s.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {canEdit ? (
          <div>
            <LoadingButton
              size="sm"
              onClick={save}
              loading={busy}
              loadingText="Saving"
              disabled={!dirty}
            >
              Save mapping
            </LoadingButton>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
