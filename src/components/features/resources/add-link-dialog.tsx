"use client";

import * as React from "react";
import { PlusIcon } from "lucide-react";
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
import { api, ApiClientError } from "@/lib/api-client";
import {
  RESOURCE_ACTOR_LABELS,
  parseResourceUrl,
} from "@/lib/constants/client-resources";
import type { ClientLinkDTO } from "@/types";

import type { OrderOption } from "./add-file-dialog";

interface AddLinkDialogProps {
  customerId: string;
  lockedOrderId?: string | null;
  lockedOrderNumber?: string | null;
  orderOptions?: OrderOption[];
  /** Present = edit mode. Absent = create mode. */
  link?: ClientLinkDTO | null;
  onSaved: (link: ClientLinkDTO) => void;
  /** Controlled open state. Supplied when another surface opens this
   *  dialog (e.g. "this file is too large — add it as a link"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Omit the built-in trigger when the dialog is opened externally. */
  hideTrigger?: boolean;
  variant?: "default" | "outline";
  size?: "default" | "sm";
}

const NO_ORDER = "none";

/**
 * + Add Link.
 *
 * Four fields, and only one of them is required thinking: the URL. A
 * link is how a 2 GB render, a Drive folder, a Figma prototype, or a
 * live dashboard becomes part of the client record — so the form gets
 * out of the way, and TraceTxn derives the source ("Google Drive",
 * "WeTransfer") from the URL rather than asking.
 *
 * Doubles as the edit dialog: same fields, same validation, so an
 * operator fixing a typo'd URL sees exactly the form they filled in.
 */
export function AddLinkDialog({
  customerId,
  lockedOrderId = null,
  lockedOrderNumber = null,
  orderOptions = [],
  link = null,
  onSaved,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  variant = "default",
  size = "sm",
}: AddLinkDialogProps) {
  const isEdit = Boolean(link);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      else setUncontrolledOpen(next);
    },
    [onOpenChange],
  );

  const initialOrder = link?.orderId ?? lockedOrderId ?? NO_ORDER;
  const [name, setName] = React.useState(link?.name ?? "");
  const [url, setUrl] = React.useState(link?.url ?? "");
  const [description, setDescription] = React.useState(link?.description ?? "");
  const [orderId, setOrderId] = React.useState<string>(initialOrder);
  // Provenance, same as files: a Drive folder the client shared belongs
  // on the record as theirs.
  const [fromClient, setFromClient] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Re-seed when the dialog opens, or when it's re-pointed at a
  // different link. Keyed on (open, link id) so typing inside an open
  // dialog is never clobbered by a parent re-render.
  const seededFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const token = open ? `${link?.id ?? "new"}` : null;
    if (token === null) {
      seededFor.current = null;
      return;
    }
    if (token !== seededFor.current) {
      seededFor.current = token;
      setName(link?.name ?? "");
      setUrl(link?.url ?? "");
      setDescription(link?.description ?? "");
      setOrderId(link?.orderId ?? lockedOrderId ?? NO_ORDER);
      setFromClient(false);
      setError(null);
    }
  }, [open, link, lockedOrderId]);

  const uid = React.useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  const preview = parseResourceUrl(url);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the link a name your team will recognise.");
      return;
    }
    if (!preview) {
      setError("Enter a valid web address starting with http:// or https://");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        url: preview.url,
        description: description.trim() || null,
        orderId: orderId === NO_ORDER ? null : orderId,
      };
      const saved = isEdit
        ? await api.patch<ClientLinkDTO>(`/api/links/${link!.id}`, payload)
        : await api.post<ClientLinkDTO>("/api/links", {
            ...payload,
            customerId,
            addedByClient: fromClient,
          });
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`);
      onSaved(saved);
      setOpen(false);
      if (!isEdit) {
        setName("");
        setUrl("");
        setDescription("");
        setOrderId(lockedOrderId ?? NO_ORDER);
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't save that link",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {hideTrigger ? null : (
        <DialogTrigger asChild>
          <Button variant={variant} size={size} className="gap-1.5">
            <PlusIcon className="size-3.5" />
            Add link
          </Button>
        </DialogTrigger>
      )}
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit link" : "Add a link"}</DialogTitle>
          <DialogDescription>
            {lockedOrderNumber
              ? `Saved against order ${lockedOrderNumber} and visible from the client's Links.`
              : "Large files, shared folders, dashboards, videos — anything that lives outside TraceTxn."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("link-name")}>Link name</Label>
              <Input
                id={fieldId("link-name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Final Project Video"
                maxLength={200}
                autoFocus
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("link-url")}>URL</Label>
              <Input
                id={fieldId("link-url")}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://drive.google.com/…"
                maxLength={2048}
                disabled={submitting}
                inputMode="url"
              />
              {preview ? (
                <p className="text-[11px] text-muted-foreground">
                  Source:{" "}
                  <span className="font-medium text-foreground">
                    {preview.source}
                  </span>
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Paste the full address. We store the link, never the file
                  behind it.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("link-desc")}>
                Description{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id={fieldId("link-desc")}
                rows={2}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Final edited video shared with the client."
                disabled={submitting}
              />
            </div>

            {isEdit ? null : (
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("link-provider")}>Added by</Label>
                <Select
                  value={fromClient ? "CLIENT" : "BUSINESS"}
                  onValueChange={(v) => setFromClient(v === "CLIENT")}
                  disabled={submitting}
                >
                  <SelectTrigger id={fieldId("link-provider")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BUSINESS">Our team</SelectItem>
                    <SelectItem value="CLIENT">
                      {RESOURCE_ACTOR_LABELS.CLIENT.replace("Uploaded", "Shared")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {lockedOrderId && !isEdit ? (
              <div className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12.5px] text-muted-foreground">
                Related order:{" "}
                <span className="font-medium text-foreground">
                  {lockedOrderNumber ?? "this order"}
                </span>
              </div>
            ) : orderOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("link-order")}>
                  Related order{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={orderId}
                  onValueChange={setOrderId}
                  disabled={submitting}
                >
                  <SelectTrigger id={fieldId("link-order")}>
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
              loadingText="Saving"
              disabled={submitting}
            >
              {isEdit ? "Save changes" : "Save"}
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
