"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import { CUSTOM_TEMPLATE_KEY_REGEX } from "@/lib/constants/email-templates";

interface CreatedTemplate {
  templateKey: string;
  displayName: string;
}

interface NewCustomTemplateButtonProps {
  variant?: "default" | "outline";
}

/**
 * Compact create-template dialog. Two inputs that matter (name +
 * key), optional description. On submit, calls the create endpoint
 * and routes straight into the editor so the operator can write the
 * actual copy.
 */
export function NewCustomTemplateButton({
  variant = "default",
}: NewCustomTemplateButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [description, setDescription] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);

  // Auto-derive a kebab key from the display name until the operator
  // edits the key themselves.
  const derivedKey = slugifyDisplayName(displayName);
  const effectiveKey = keyTouched ? templateKey : derivedKey;

  function reset() {
    setDisplayName("");
    setTemplateKey("");
    setDescription("");
    setKeyTouched(false);
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    const key = effectiveKey.trim().toLowerCase();
    if (name.length < 2) {
      setError("Pick a name your team will recognise.");
      return;
    }
    if (!CUSTOM_TEMPLATE_KEY_REGEX.test(key)) {
      setError(
        "Key must be lower-case kebab (e.g. payment-reminder), 2 to 48 characters, starting with a letter.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.post<CreatedTemplate>(
        "/api/admin/email-templates/custom",
        {
          templateKey: key,
          displayName: name,
          description: description.trim() || undefined,
        },
      );
      toast.success(`Created template "${created.displayName}"`);
      setOpen(false);
      reset();
      router.push(`/app/admin/email-templates/${created.templateKey}`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not create template",
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
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} size="sm" className="gap-1.5">
          <PlusIcon className="size-3.5" />
          New custom template
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New custom template</DialogTitle>
          <DialogDescription>
            Name the template, set its key, and we&apos;ll drop you into the
            editor to write the copy.
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
              <Label htmlFor="new-tpl-name">Display name</Label>
              <Input
                id="new-tpl-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Payment Reminder"
                maxLength={120}
                autoFocus
                disabled={submitting}
              />
              <p className="text-[11px] text-muted-foreground">
                What your team sees in the template picker.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-tpl-key">Template key</Label>
              <Input
                id="new-tpl-key"
                value={effectiveKey}
                onChange={(e) => {
                  setKeyTouched(true);
                  setTemplateKey(e.target.value.toLowerCase());
                }}
                placeholder="payment-reminder"
                maxLength={48}
                disabled={submitting}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Lower-case kebab. Used in the URL and stays the same across
                renames.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-tpl-desc">
                Description{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="new-tpl-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When to send this — a one-liner for your team."
                maxLength={500}
                rows={2}
                disabled={submitting}
              />
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
              loadingText="Creating"
            >
              Create and edit
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function slugifyDisplayName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
