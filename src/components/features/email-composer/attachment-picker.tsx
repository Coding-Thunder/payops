"use client";

import * as React from "react";
import { CheckIcon, SearchIcon } from "lucide-react";

import { AddFileDialog } from "@/components/features/resources/add-file-dialog";
import { FileTypeIcon } from "@/components/features/resources/file-type-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatFileSize } from "@/lib/constants/client-resources";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useClientFiles, useInvalidateResources } from "@/hooks/use-client-resources";
import type { ClientFileDTO } from "@/types";

interface AttachmentPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  /** The order the email is attributed to, when there is one. Gates the
   *  Order Files tab and pre-fills any upload made from here. */
  orderId: string | null;
  orderNumber: string | null;
  /** What's already attached. Passed as full rows, not ids, so
   *  re-opening the picker can show the current selection even for a
   *  file that isn't on the page of results currently loaded. */
  selected: ClientFileDTO[];
  onConfirm: (files: ClientFileDTO[]) => void;
}

/**
 * Attach File → Upload new · Client Files · Order Files.
 *
 * The whole reason this exists: an operator should never have to
 * download a proposal out of TraceTxn just to upload it back in as an
 * email attachment. The file is already here, related to this client and
 * often to this order — so attaching it is picking it off a list.
 *
 * A file uploaded FROM here is a real client file, not a transient
 * attachment: it lands in Client Files (and Order Files, when the email
 * has an order) the moment it uploads, which is what stops attachments
 * from disappearing into a sent-mail folder.
 */
export function AttachmentPicker({
  open,
  onOpenChange,
  customerId,
  orderId,
  orderNumber,
  selected,
  onConfirm,
}: AttachmentPickerProps) {
  const [tab, setTab] = React.useState<"client" | "order">(
    orderId ? "order" : "client",
  );
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [picked, setPicked] = React.useState<Record<string, ClientFileDTO>>({});
  const invalidate = useInvalidateResources();

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  // Seed from what's already attached each time the picker OPENS, so
  // "Attach" replaces the selection rather than only ever adding to it —
  // and so an operator who opens the picker to remove one file doesn't
  // lose the other three. Gated on the open-transition (not on `open`
  // itself) so re-renders while the picker is open don't wipe an
  // in-progress selection.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setPicked(Object.fromEntries(selected.map((f) => [f.id, f])));
      setTab(orderId ? "order" : "client");
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;
    }
  }, [open, orderId, selected]);

  const clientQuery = useClientFiles(
    { customerId, q: debounced || undefined },
    open,
  );
  const orderQuery = useClientFiles(
    { customerId, orderId: orderId ?? undefined, q: debounced || undefined },
    open && Boolean(orderId),
  );

  function toggle(file: ClientFileDTO) {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[file.id]) delete next[file.id];
      else next[file.id] = file;
      return next;
    });
  }

  const chosen = Object.values(picked);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Attach a file</DialogTitle>
          <DialogDescription>
            Pick from files already on this client&rsquo;s record, or upload a
            new one — it&rsquo;s saved to their Files either way.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by file name"
                className="pl-8"
                aria-label="Search files"
              />
            </div>
            <AddFileDialog
              customerId={customerId}
              lockedOrderId={orderId}
              lockedOrderNumber={orderNumber}
              variant="outline"
              onCreated={(file) => {
                invalidate();
                // A file uploaded from the composer is one the operator
                // means to send right now — attach it without a second
                // trip through the list.
                setPicked((prev) => ({ ...prev, [file.id]: file }));
              }}
            />
          </div>

          {orderId ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "client" | "order")}>
              <TabsList>
                <TabsTrigger value="order">
                  Order files{orderNumber ? ` · ${orderNumber}` : ""}
                </TabsTrigger>
                <TabsTrigger value="client">All client files</TabsTrigger>
              </TabsList>
              <TabsContent value="order">
                <FileList
                  files={orderQuery.data}
                  loading={orderQuery.isLoading}
                  picked={picked}
                  onToggle={toggle}
                  emptyLabel="No files on this order yet."
                />
              </TabsContent>
              <TabsContent value="client">
                <FileList
                  files={clientQuery.data}
                  loading={clientQuery.isLoading}
                  picked={picked}
                  onToggle={toggle}
                  emptyLabel="No files for this client yet."
                />
              </TabsContent>
            </Tabs>
          ) : (
            <FileList
              files={clientQuery.data}
              loading={clientQuery.isLoading}
              picked={picked}
              onToggle={toggle}
              emptyLabel="No files for this client yet."
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onConfirm(chosen);
              onOpenChange(false);
            }}
          >
            {chosen.length === 0
              ? "Attach"
              : `Attach ${chosen.length} file${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileList({
  files,
  loading,
  picked,
  onToggle,
  emptyLabel,
}: {
  files: ClientFileDTO[] | undefined;
  loading: boolean;
  picked: Record<string, ClientFileDTO>;
  onToggle: (file: ClientFileDTO) => void;
  emptyLabel: string;
}) {
  if (loading) {
    return (
      <div className="space-y-2 pt-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (!files || files.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-6 text-center text-[12.5px] text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className="max-h-[300px] space-y-1 overflow-y-auto pt-1">
      {files.map((file) => {
        const isPicked = Boolean(picked[file.id]);
        return (
          <li key={file.id}>
            <button
              type="button"
              onClick={() => onToggle(file)}
              aria-pressed={isPicked}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                isPicked
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent hover:bg-muted/40",
              )}
            >
              <FileTypeIcon extension={file.extension} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {file.fileName}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {formatFileSize(file.sizeBytes)} ·{" "}
                  {formatRelative(file.createdAt)}
                  {file.orderNumber ? ` · ${file.orderNumber}` : ""}
                </span>
              </span>
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border",
                  isPicked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {isPicked ? <CheckIcon className="size-3" /> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
