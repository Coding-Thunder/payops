"use client";

import * as React from "react";
import { PaperclipIcon, PlusIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { ApiClientError } from "@/lib/api-client";
import {
  FILE_ACCEPT_ATTRIBUTE,
  FILE_VISIBILITY_HINTS,
  FILE_VISIBILITY_LABELS,
  FileVisibility,
  RESOURCE_ACTOR_LABELS,
  LARGE_FILE_GUIDANCE,
  MAX_FILE_UPLOAD_BYTES,
  MAX_FILE_UPLOAD_LABEL,
  extensionOf,
  formatFileSize,
  isSupportedFileName,
  supportedFormatsByGroup,
} from "@/lib/constants/client-resources";
import { cn } from "@/lib/utils";
import type { ClientFileDTO } from "@/types";

export interface OrderOption {
  id: string;
  orderNumber: string;
}

interface AddFileDialogProps {
  customerId: string;
  /** Pre-selected + locked when the dialog is opened from inside an
   *  order. The operator is never asked to re-state context we have. */
  lockedOrderId?: string | null;
  lockedOrderNumber?: string | null;
  /** Client-scope only: orders this file can be related to. */
  orderOptions?: OrderOption[];
  onCreated: (file: ClientFileDTO) => void;
  /** Escape hatch shown when the chosen file is too big — the whole
   *  point of the Links section. */
  onSwitchToLink?: () => void;
  variant?: "default" | "outline";
  size?: "default" | "sm";
}

const NO_ORDER = "none";

/**
 * + Add File.
 *
 * Deliberately five fields and no wizard: pick the file, say what it is,
 * relate it if it belongs to an order, choose who can see it, save.
 * Context that TraceTxn already knows (the client, and the order when
 * you opened this from one) is filled in and stays out of the way.
 *
 * The size rule is enforced BEFORE the upload spends the operator's
 * bandwidth, and the failure is a signpost rather than an error: a 300 MB
 * video isn't a mistake to be scolded for, it's a Link.
 */
export function AddFileDialog({
  customerId,
  lockedOrderId = null,
  lockedOrderNumber = null,
  orderOptions = [],
  onCreated,
  onSwitchToLink,
  variant = "default",
  size = "sm",
}: AddFileDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [description, setDescription] = React.useState("");
  const [orderId, setOrderId] = React.useState<string>(
    lockedOrderId ?? NO_ORDER,
  );
  const [visibility, setVisibility] = React.useState<FileVisibility>(
    FileVisibility.INTERNAL,
  );
  // Who this file came FROM. Requirements, brand assets and reference
  // images arrive from the client's side and need to read that way on
  // the record — even when a teammate is the one saving them.
  const [fromClient, setFromClient] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [oversized, setOversized] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Scoped ids: this dialog can be mounted more than once at a time.
  const uid = React.useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  function reset() {
    setFile(null);
    setDescription("");
    setOrderId(lockedOrderId ?? NO_ORDER);
    setVisibility(FileVisibility.INTERNAL);
    setFromClient(false);
    setError(null);
    setOversized(false);
    setSubmitting(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handlePick(picked: File | null) {
    setError(null);
    setOversized(false);
    if (!picked) {
      setFile(null);
      return;
    }
    // Both checks happen again server-side; doing them here saves the
    // operator a round-trip and gives a specific, actionable message.
    if (!isSupportedFileName(picked.name)) {
      const ext = extensionOf(picked.name);
      setFile(null);
      setError(
        ext
          ? `.${ext} files aren't supported yet. Add it as a link instead.`
          : "That file has no recognisable extension.",
      );
      return;
    }
    if (picked.size > MAX_FILE_UPLOAD_BYTES) {
      setFile(null);
      setOversized(true);
      setError(LARGE_FILE_GUIDANCE);
      return;
    }
    setFile(picked);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("customerId", customerId);
      if (orderId !== NO_ORDER) form.append("orderId", orderId);
      if (description.trim()) form.append("description", description.trim());
      form.append("visibility", visibility);
      if (fromClient) form.append("uploadedByClient", "true");

      // Raw fetch, not the JSON api client: multipart must set its own
      // Content-Type (with the boundary) and must not be stringified.
      const res = await fetch("/api/files", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new ApiClientError(res.status, {
          code: payload?.error?.code ?? "INTERNAL_ERROR",
          message: payload?.error?.message ?? "Couldn't upload that file",
        });
      }
      const created = payload?.data as ClientFileDTO;
      toast.success(`Added ${created.fileName}`);
      onCreated(created);
      setOpen(false);
      reset();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't upload that file",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const groups = supportedFormatsByGroup();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5">
          <PlusIcon className="size-3.5" />
          Add file
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a file</DialogTitle>
          <DialogDescription>
            {lockedOrderNumber
              ? `Saved against order ${lockedOrderNumber} and visible from the client's Files.`
              : "Saved against this client. Relate it to an order if it belongs to one."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert variant={oversized ? "default" : "destructive"}>
                <AlertDescription className="space-y-2">
                  <p>{error}</p>
                  {oversized && onSwitchToLink ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpen(false);
                        reset();
                        onSwitchToLink();
                      }}
                    >
                      Add it as a link instead
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-input")}>File</Label>
              <label
                htmlFor={fieldId("file-input")}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-1.5",
                  "rounded-lg border border-dashed border-border bg-surface-1 px-4 py-6",
                  "text-center transition-colors hover:bg-muted/40",
                  submitting && "pointer-events-none opacity-60",
                )}
              >
                {file ? (
                  <>
                    <PaperclipIcon className="size-4 text-muted-foreground" />
                    <span className="text-[13px] font-medium text-foreground">
                      {file.name}
                    </span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {formatFileSize(file.size)} · click to choose a
                      different file
                    </span>
                  </>
                ) : (
                  <>
                    <UploadIcon className="size-4 text-muted-foreground" />
                    <span className="text-[13px] font-medium text-foreground">
                      Choose a file
                    </span>
                    <span className="text-[11.5px] text-muted-foreground">
                      Maximum file size: {MAX_FILE_UPLOAD_LABEL}
                    </span>
                  </>
                )}
              </label>
              <input
                ref={inputRef}
                id={fieldId("file-input")}
                type="file"
                className="sr-only"
                accept={FILE_ACCEPT_ATTRIBUTE}
                disabled={submitting}
                onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
              />
              <div className="rounded-md bg-surface-1 px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Supported business file formats
                </p>
                <ul className="mt-1 space-y-0.5">
                  {groups.map((g) => (
                    <li key={g.group} className="text-[11.5px] text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {g.label}:
                      </span>{" "}
                      {g.extensions.join(", ")}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  Maximum file size: {MAX_FILE_UPLOAD_LABEL}. Anything
                  larger belongs in Links.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-desc")}>
                Description{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id={fieldId("file-desc")}
                rows={2}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this is, and why it matters."
                disabled={submitting}
              />
            </div>

            {lockedOrderId ? (
              <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12.5px] text-muted-foreground">
                Related order:{" "}
                <span className="font-medium text-foreground">
                  {lockedOrderNumber ?? "this order"}
                </span>
              </div>
            ) : orderOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("file-order")}>
                  Related order{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={orderId}
                  onValueChange={setOrderId}
                  disabled={submitting}
                >
                  <SelectTrigger id={fieldId("file-order")}>
                    <SelectValue placeholder="Not related to an order" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ORDER}>
                      Not related to an order
                    </SelectItem>
                    {orderOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.orderNumber}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-provider")}>Provided by</Label>
              <Select
                value={fromClient ? "CLIENT" : "BUSINESS"}
                onValueChange={(v) => setFromClient(v === "CLIENT")}
                disabled={submitting}
              >
                <SelectTrigger id={fieldId("file-provider")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BUSINESS">
                    {RESOURCE_ACTOR_LABELS.BUSINESS}
                  </SelectItem>
                  <SelectItem value="CLIENT">
                    {RESOURCE_ACTOR_LABELS.CLIENT}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("file-visibility")}>Visibility</Label>
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v as FileVisibility)}
                disabled={submitting}
              >
                <SelectTrigger id={fieldId("file-visibility")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FileVisibility.INTERNAL}>
                    {FILE_VISIBILITY_LABELS.INTERNAL}
                  </SelectItem>
                  <SelectItem value={FileVisibility.SHARED}>
                    {FILE_VISIBILITY_LABELS.SHARED}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {FILE_VISIBILITY_HINTS[visibility]}
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <LoadingButton
              type="submit"
              loading={submitting}
              loadingText="Uploading"
              disabled={!file || submitting}
            >
              Save
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
