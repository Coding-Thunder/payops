"use client";

import * as React from "react";
import { LinkIcon, SearchIcon } from "lucide-react";

import { AddLinkDialog } from "@/components/features/resources/add-link-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative } from "@/lib/format";
import { useClientLinks, useInvalidateResources } from "@/hooks/use-client-resources";
import type { ClientLinkDTO } from "@/types";

interface LinkPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  orderId: string | null;
  orderNumber: string | null;
  /** Called with the link to write into the message at the caret. */
  onInsert: (link: ClientLinkDTO) => void;
}

/**
 * Insert Link → Client Links · Order Links · Add new.
 *
 * Picking a link writes it into the message where the cursor is, so the
 * operator sees the sentence they're actually sending ("You can view the
 * final video here: …") instead of trusting an invisible attachment
 * list.
 *
 * A link added from here is saved to the client's Links first, then
 * inserted. That ordering is the point of the feature: the resource
 * stops being something that only exists inside one sent email.
 */
export function LinkPicker({
  open,
  onOpenChange,
  customerId,
  orderId,
  orderNumber,
  onInsert,
}: LinkPickerProps) {
  const [tab, setTab] = React.useState<"client" | "order">(
    orderId ? "order" : "client",
  );
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const invalidate = useInvalidateResources();

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  // Default to the order's own links when the email is attributed to
  // one — that's the narrower, likelier list. Only on the open
  // transition, so switching tabs by hand sticks.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setTab(orderId ? "order" : "client");
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;
    }
  }, [open, orderId]);

  const clientQuery = useClientLinks(
    { customerId, q: debounced || undefined },
    open,
  );
  const orderQuery = useClientLinks(
    { customerId, orderId: orderId ?? undefined, q: debounced || undefined },
    open && Boolean(orderId),
  );

  function choose(link: ClientLinkDTO) {
    onInsert(link);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Insert a link</DialogTitle>
          <DialogDescription>
            Drops the link into your message at the cursor, and records that
            it was shared with this client.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by link name"
                className="pl-8"
                aria-label="Search links"
              />
            </div>
            <AddLinkDialog
              customerId={customerId}
              lockedOrderId={orderId}
              lockedOrderNumber={orderNumber}
              variant="outline"
              onSaved={(link) => {
                invalidate();
                // Saved to the client's Links, then straight into the
                // message — the operator asked for one thing, not two.
                choose(link);
              }}
            />
          </div>

          {orderId ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "client" | "order")}>
              <TabsList>
                <TabsTrigger value="order">
                  Order links{orderNumber ? ` · ${orderNumber}` : ""}
                </TabsTrigger>
                <TabsTrigger value="client">All client links</TabsTrigger>
              </TabsList>
              <TabsContent value="order">
                <LinkList
                  links={orderQuery.data}
                  loading={orderQuery.isLoading}
                  onChoose={choose}
                  emptyLabel="No links on this order yet."
                />
              </TabsContent>
              <TabsContent value="client">
                <LinkList
                  links={clientQuery.data}
                  loading={clientQuery.isLoading}
                  onChoose={choose}
                  emptyLabel="No links for this client yet."
                />
              </TabsContent>
            </Tabs>
          ) : (
            <LinkList
              links={clientQuery.data}
              loading={clientQuery.isLoading}
              onChoose={choose}
              emptyLabel="No links for this client yet."
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function LinkList({
  links,
  loading,
  onChoose,
  emptyLabel,
}: {
  links: ClientLinkDTO[] | undefined;
  loading: boolean;
  onChoose: (link: ClientLinkDTO) => void;
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
  if (!links || links.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-6 text-center text-[12.5px] text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className="max-h-[300px] space-y-1 overflow-y-auto pt-1">
      {links.map((link) => (
        <li key={link.id}>
          <button
            type="button"
            onClick={() => onChoose(link)}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-foreground ring-1 ring-inset ring-border">
              <LinkIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">
                {link.name}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {link.source} · {formatRelative(link.createdAt)}
                {link.orderNumber ? ` · ${link.orderNumber}` : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
