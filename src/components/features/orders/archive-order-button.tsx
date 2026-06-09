"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchiveIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { api, ApiClientError } from "@/lib/api-client";

interface ArchiveOrderButtonProps {
  orderId: string;
}

export function ArchiveOrderButton({ orderId }: ArchiveOrderButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function onConfirm() {
    try {
      await api.del(`/api/orders/${orderId}`, {
        reason: reason.trim() || undefined,
      });
      toast.success("Order archived");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not archive";
      toast.error(message);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArchiveIcon className="size-3.5" />
        Archive
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setReason("");
        }}
        tone="destructive"
        icon={<ArchiveIcon />}
        title="Archive this order?"
        description="Archived orders stay in the database for audit purposes but are hidden from the active list. Paid orders cannot be archived."
        confirmLabel="Archive order"
        onConfirm={onConfirm}
      >
        <div className="space-y-1.5">
          <Label htmlFor="archive-reason">Reason (optional)</Label>
          <Textarea
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Customer cancelled, duplicate, etc."
            rows={3}
          />
        </div>
      </ConfirmDialog>
    </>
  );
}
