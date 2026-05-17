"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchiveIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";

interface ArchiveOrderButtonProps {
  orderId: string;
}

export function ArchiveOrderButton({ orderId }: ArchiveOrderButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setSubmitting(true);
    try {
      await api.del(`/api/orders/${orderId}`, {
        reason: reason.trim() || undefined,
      });
      toast.success("Order archived");
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not archive";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ArchiveIcon className="size-3.5" />
          Archive
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive order?</DialogTitle>
          <DialogDescription>
            Archived orders stay in the database for audit purposes but are
            hidden from the active list. Paid orders cannot be archived.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="archive-reason">Reason (optional)</Label>
          <Textarea
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Customer cancelled, duplicate, etc."
            rows={3}
            disabled={submitting}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : null}
            Archive order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
