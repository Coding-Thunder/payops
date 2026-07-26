"use client";

import { useRouter } from "next/navigation";
import { PencilIcon, XIcon } from "lucide-react";
import * as React from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface EditClientDialogProps {
  client: {
    id: string;
    name: string;
    phone: string;
    company: string | null;
    notes: string | null;
    tags: string[];
  };
}

/**
 * Edit a Client Profile's operator-owned fields (name, phone, company,
 * notes, tags). Email is intentionally NOT editable — it's the identity
 * key the order pipeline joins on. Persists via `PATCH /api/customers/:id`
 * (admin-gated, audited) and refreshes the server component on success.
 */
export function EditClientDialog({ client }: EditClientDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [name, setName] = React.useState(client.name);
  const [phone, setPhone] = React.useState(client.phone);
  const [company, setCompany] = React.useState(client.company ?? "");
  const [notes, setNotes] = React.useState(client.notes ?? "");
  const [tags, setTags] = React.useState<string[]>(client.tags);
  const [tagDraft, setTagDraft] = React.useState("");

  function reset() {
    setName(client.name);
    setPhone(client.phone);
    setCompany(client.company ?? "");
    setNotes(client.notes ?? "");
    setTags(client.tags);
    setTagDraft("");
    setError(null);
    setSubmitting(false);
  }

  function addTag(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setTags((prev) =>
      prev.some((t) => t.toLowerCase() === v.toLowerCase()) || prev.length >= 50
        ? prev
        : [...prev, v],
    );
    setTagDraft("");
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name can't be empty.");
      return;
    }
    // Fold a half-typed tag into the payload so it isn't silently lost.
    const finalTags = tagDraft.trim()
      ? Array.from(new Set([...tags, tagDraft.trim()])).slice(0, 50)
      : tags;

    setSubmitting(true);
    try {
      await api.patch(`/api/customers/${client.id}`, {
        name: trimmedName,
        phone: phone.trim(),
        company: company.trim() || null,
        notes: notes.trim() || null,
        tags: finalTags,
      });
      toast.success("Client updated");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't save changes",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <PencilIcon className="size-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit client</DialogTitle>
            <DialogDescription>
              Update the details your team owns. The email address is the
              record key and can&apos;t be changed here.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="client-name">Name</Label>
                <Input
                  id="client-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="client-phone">Phone</Label>
                <Input
                  id="client-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={32}
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="client-company">Company</Label>
              <Input
                id="client-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={160}
                placeholder="Optional"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="client-tags">Tags</Label>
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-1 py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-foreground ring-1 ring-inset ring-border"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                        aria-label={`Remove ${tag}`}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <Input
                id="client-tags"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagDraft);
                  } else if (
                    e.key === "Backspace" &&
                    !tagDraft &&
                    tags.length > 0
                  ) {
                    removeTag(tags[tags.length - 1]);
                  }
                }}
                onBlur={() => addTag(tagDraft)}
                maxLength={40}
                placeholder="Type a tag, press Enter"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="client-notes">Notes</Label>
              <Textarea
                id="client-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={4000}
                rows={4}
                placeholder="Context your team should know — preferences, history, anything worth remembering."
                className={cn("resize-none")}
              />
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                {notes.length}/4000
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
            <LoadingButton type="submit" loading={submitting}>
              Save changes
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
