"use client";

import * as React from "react";
import { MailPlusIcon, SendIcon } from "lucide-react";
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
import type { EmailTemplateSummaryDTO } from "@/types";

type Source =
  | { kind: "order"; orderId: string; orderNumber?: string }
  | { kind: "customer"; customerId: string };

interface SendTemplateButtonProps {
  /** Pre-filled recipient email. The dialog still lets the operator
   *  edit it before sending — useful if the customer record has a
   *  stale address. */
  defaultRecipient: string;
  /** Context the send is attributed to. When kind === "order" the
   *  server also writes an evidence row against the order so the
   *  dispute artifact captures the manual touchpoint. */
  source: Source;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm";
  /** Label override; defaults to "Send template". */
  label?: string;
}

/**
 * Dialog-wrapped button that lets an operator pick any active
 * template (system or custom) and dispatch it manually. Pre-fills
 * the recipient from context and exposes the per-send subject /
 * intro / note overrides.
 *
 * Calls `GET /api/admin/email-templates` lazily (on dialog open) so
 * the order detail page doesn't pay the cost on every render.
 */
export function SendTemplateButton({
  defaultRecipient,
  source,
  variant = "outline",
  size = "sm",
  label = "Send template",
}: SendTemplateButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<EmailTemplateSummaryDTO[] | null>(null);
  const [templatesError, setTemplatesError] = React.useState<string | null>(null);
  const [templatesLoading, setTemplatesLoading] = React.useState(false);

  const [selectedKey, setSelectedKey] = React.useState<string>("");
  const [recipient, setRecipient] = React.useState(defaultRecipient);
  const [subjectOverride, setSubjectOverride] = React.useState("");
  const [introOverride, setIntroOverride] = React.useState("");

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    setSelectedKey("");
    setRecipient(defaultRecipient);
    setSubjectOverride("");
    setIntroOverride("");
    setError(null);
    setSubmitting(false);
  }

  React.useEffect(() => {
    if (!open) return;
    if (templates !== null) return;
    let cancelled = false;
    // Defer one frame so the setState flips don't fire synchronously
    // inside the effect (cascading-render lint rule).
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      setTemplatesLoading(true);
      api
        .get<{ templates: EmailTemplateSummaryDTO[] }>("/api/admin/email-templates")
        .then((data) => {
          if (cancelled) return;
          setTemplates(data.templates);
          setTemplatesError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setTemplatesError(
            err instanceof ApiClientError ? err.message : "Couldn't load templates",
          );
        })
        .finally(() => {
          if (!cancelled) setTemplatesLoading(false);
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [open, templates]);

  const sendable = (templates ?? []).filter((t) => t.hasActiveVersion);
  const selected = sendable.find((t) => t.templateKey === selectedKey) ?? null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError("Pick a template to send.");
      return;
    }
    const to = recipient.trim();
    if (!to) {
      setError("Recipient email is required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(
        `/api/admin/email-templates/${selected.templateKey}/send`,
        {
          to,
          source,
          overrides: {
            subject: subjectOverride.trim() || undefined,
            intro: introOverride.trim() || undefined,
          },
        },
      );
      toast.success(`Sent "${selected.displayName}" to ${to}`);
      setOpen(false);
      reset();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't send template",
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
        <Button variant={variant} size={size} className="gap-1.5">
          <MailPlusIcon className="size-3.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>
            Pick a template, tweak the copy if you need to, and send. Sends
            attributed to{" "}
            {source.kind === "order"
              ? source.orderNumber
                ? `order ${source.orderNumber}`
                : "this order"
              : "this customer"}
            .
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
              <Label htmlFor="send-tpl">Template</Label>
              <Select
                value={selectedKey}
                onValueChange={setSelectedKey}
                disabled={submitting || templatesLoading}
              >
                <SelectTrigger id="send-tpl">
                  <SelectValue
                    placeholder={
                      templatesLoading
                        ? "Loading templates…"
                        : "Choose a template"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sendable.map((t) => (
                    <SelectItem key={t.templateKey} value={t.templateKey}>
                      {t.displayName}
                    </SelectItem>
                  ))}
                  {sendable.length === 0 && !templatesLoading ? (
                    <div className="p-3 text-[12.5px] text-muted-foreground">
                      No sendable templates yet. Save an active version in the
                      template editor first.
                    </div>
                  ) : null}
                </SelectContent>
              </Select>
              {templatesError ? (
                <p className="text-[11px] text-destructive">{templatesError}</p>
              ) : selected?.description ? (
                <p className="text-[11px] text-muted-foreground">
                  {selected.description}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-tpl-to">Recipient</Label>
              <Input
                id="send-tpl-to"
                type="email"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="customer@example.com"
                maxLength={254}
                disabled={submitting}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="send-tpl-subject">
                  Subject override{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="send-tpl-subject"
                  value={subjectOverride}
                  onChange={(e) => setSubjectOverride(e.target.value)}
                  placeholder={selected?.displayName ?? ""}
                  maxLength={200}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="send-tpl-intro">
                  Intro override{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="send-tpl-intro"
                  value={introOverride}
                  onChange={(e) => setIntroOverride(e.target.value)}
                  placeholder="One-off message above the saved copy."
                  maxLength={2000}
                  rows={2}
                  disabled={submitting}
                />
              </div>
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
              loadingText="Sending"
              disabled={!selected || submitting}
            >
              <SendIcon className="size-3.5" />
              Send now
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
