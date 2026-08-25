"use client";

import * as React from "react";
import {
  FileTextIcon,
  LinkIcon,
  Loader2Icon,
  MailPlusIcon,
  PaperclipIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  InsertVariableMenu,
  focusCaret,
  insertAtCaret,
} from "@/components/features/email-templates/insert-variable-menu";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import { formatFileSize } from "@/lib/constants/client-resources";
import { manualVariablesUsed } from "@/lib/constants/email-variables";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { useInvalidateResources } from "@/hooks/use-client-resources";
import { cn } from "@/lib/utils";
import type { ClientFileDTO, ClientLinkDTO, ComposeContextDTO } from "@/types";

import { AttachmentPicker } from "./attachment-picker";
import { LinkPicker } from "./link-picker";

interface EmailComposerDialogProps {
  customerId: string;
  /** Prefilled recipient. Editable — a client record can carry a stale
   *  address and the operator may know better. */
  defaultRecipient: string;
  /** Opened from an order: the relationship is fixed and every picker,
   *  variable, and upload inherits it. */
  lockedOrderId?: string | null;
  lockedOrderNumber?: string | null;
  label?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm";
  onSent?: () => void;
}

const NO_ORDER = "none";
const PREVIEW_DEBOUNCE_MS = 450;

/**
 * Send Email — the composer.
 *
 * Two things it refuses to do, both of which the old dialog did:
 *
 * 1. Ask for context it already has. The client, their address, the
 *    order you opened this from, the business name, the invoice number —
 *    all resolved server-side. The operator supplies only what TraceTxn
 *    genuinely cannot know (a meeting link, a status line), and only
 *    when the copy actually asks for it.
 *
 * 2. Make you choose a mode before you can start. It opens on a blank
 *    email. "Use template" is a button in the toolbar, available before
 *    you type and after — picking one fills the subject and body, and
 *    every word stays editable.
 *
 * The preview tab renders through the same server function the send path
 * uses, with the same payload. There is no second renderer that can
 * disagree with it.
 */
export function EmailComposerDialog({
  customerId,
  defaultRecipient,
  lockedOrderId = null,
  lockedOrderNumber = null,
  label = "Send Email",
  variant = "outline",
  size = "sm",
  onSent,
}: EmailComposerDialogProps) {
  const [open, setOpen] = React.useState(false);
  const idempotency = useIdempotencyKey();
  const invalidateResources = useInvalidateResources();

  const [context, setContext] = React.useState<ComposeContextDTO | null>(null);
  const [contextError, setContextError] = React.useState<string | null>(null);
  const [loadingContext, setLoadingContext] = React.useState(false);

  const [to, setTo] = React.useState(defaultRecipient);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [orderId, setOrderId] = React.useState<string>(
    lockedOrderId ?? NO_ORDER,
  );
  const [templateKey, setTemplateKey] = React.useState<string | null>(null);
  const [manual, setManual] = React.useState<Record<string, string>>({});
  const [attachments, setAttachments] = React.useState<ClientFileDTO[]>([]);
  const [usedLinks, setUsedLinks] = React.useState<ClientLinkDTO[]>([]);

  const [tab, setTab] = React.useState<"write" | "preview">("write");
  const [previewHtml, setPreviewHtml] = React.useState("");
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const [attachOpen, setAttachOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const uid = React.useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const lastFocused = React.useRef<"subject" | "body">("body");

  function reset() {
    setTo(defaultRecipient);
    setSubject("");
    setBody("");
    setOrderId(lockedOrderId ?? NO_ORDER);
    setTemplateKey(null);
    setManual({});
    setAttachments([]);
    setUsedLinks([]);
    setTab("write");
    setPreviewHtml("");
    setPreviewError(null);
    setError(null);
    setSending(false);
  }

  // Load the client's context once per open. Deferred a frame so the
  // state flips don't fire synchronously inside the effect.
  React.useEffect(() => {
    if (!open || context || loadingContext) return;
    let cancelled = false;
    const handle = requestAnimationFrame(() => {
      if (cancelled) return;
      setLoadingContext(true);
      api
        .get<ComposeContextDTO>(
          `/api/emails/compose/context?customerId=${encodeURIComponent(customerId)}`,
        )
        .then((data) => {
          if (cancelled) return;
          setContext(data);
          setContextError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setContextError(
            err instanceof ApiClientError
              ? err.message
              : "Couldn't load this client's details",
          );
        })
        .finally(() => {
          if (!cancelled) setLoadingContext(false);
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, [open, context, loadingContext, customerId]);

  const selectedOrder =
    orderId === NO_ORDER
      ? null
      : (context?.orders.find((o) => o.id === orderId) ?? null);
  const effectiveOrderNumber =
    lockedOrderNumber ?? selectedOrder?.orderNumber ?? null;

  // Which variable groups the Insert menu offers. Order and payment
  // appear only when this specific send can actually resolve them.
  const availability = {
    order: orderId !== NO_ORDER,
    payment: Boolean(selectedOrder?.hasPayment ?? (lockedOrderId ? true : false)),
  };

  // Only the manual variables the copy actually uses get an input. A
  // project-update template asks for a status line; a meeting invite
  // asks for a link and a time. Neither asks for the other's fields.
  const manualVars = React.useMemo(
    () => manualVariablesUsed(subject, body),
    [subject, body],
  );

  // Link provenance is derived from the FINAL body, not from what was
  // clicked: an operator who inserts a link and then deletes the
  // sentence hasn't shared it, and the record should say so.
  const linkIds = React.useMemo(
    () => usedLinks.filter((l) => body.includes(l.url)).map((l) => l.id),
    [usedLinks, body],
  );

  const previewPayload = React.useMemo(
    () => ({
      customerId,
      orderId: orderId === NO_ORDER ? null : orderId,
      subject: subject.trim(),
      body: body.trim(),
      templateKey,
      variables: manual,
      linkIds,
      attachmentFileIds: attachments.map((a) => a.id),
    }),
    [customerId, orderId, subject, body, templateKey, manual, linkIds, attachments],
  );

  // A draft with no subject or no body has nothing to preview. Derived
  // rather than stored, so the empty state renders from what's true now
  // instead of from a cleared piece of state.
  const canPreview = Boolean(previewPayload.subject && previewPayload.body);

  // Render the preview only while the Preview tab is showing — no point
  // paying for a render nobody is looking at.
  React.useEffect(() => {
    if (!open || tab !== "preview" || !canPreview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const { html } = await api.post<{ html: string; subject: string }>(
          "/api/emails/compose/preview",
          previewPayload,
          { signal: controller.signal },
        );
        setPreviewHtml(html);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof ApiClientError ? err.message : "Couldn't render preview",
        );
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, tab, canPreview, previewPayload]);

  function applyTemplate(key: string) {
    const tpl = context?.templates.find((t) => t.templateKey === key);
    if (!tpl) return;
    setTemplateKey(tpl.templateKey);
    setSubject(tpl.subject ?? "");
    setBody(tpl.body ?? "");
    setTab("write");
    toast.success(`Loaded "${tpl.displayName}"`);
  }

  function insertText(text: string) {
    if (lastFocused.current === "subject") {
      const { value, caret } = insertAtCaret(subjectRef.current, subject, text);
      setSubject(value.slice(0, 200));
      focusCaret(subjectRef.current, caret);
      return;
    }
    const { value, caret } = insertAtCaret(bodyRef.current, body, text);
    setBody(value);
    focusCaret(bodyRef.current, caret);
  }

  function handleInsertLink(link: ClientLinkDTO) {
    // `[Label](url)` is the one piece of markup the body understands;
    // the renderer turns it into an anchor and leaves everything else
    // literal.
    insertText(`[${link.name}](${link.url})`);
    setUsedLinks((prev) =>
      prev.some((l) => l.id === link.id) ? prev : [...prev, link],
    );
  }

  const attachmentBytes = attachments.reduce((n, a) => n + a.sizeBytes, 0);

  async function handleSend() {
    setError(null);
    const recipient = to.trim();
    if (!recipient) {
      setError("Add a recipient.");
      return;
    }
    if (!subject.trim()) {
      setError("Add a subject.");
      return;
    }
    if (!body.trim()) {
      setError("Write your message.");
      return;
    }
    const missing = manualVars.filter((v) => !manual[v.token]?.trim());
    if (missing.length > 0) {
      setError(
        `Fill in ${missing.map((v) => v.label.toLowerCase()).join(", ")} before sending.`,
      );
      return;
    }

    setSending(true);
    try {
      await api.post(
        "/api/emails/compose/send",
        { ...previewPayload, to: recipient },
        { headers: { "Idempotency-Key": idempotency.take() } },
      );
      idempotency.clear();
      toast.success(`Sent to ${recipient}`);
      // Attachments and links just became "shared via email" — the
      // Files/Links lists and their filters need to reflect that.
      invalidateResources();
      setOpen(false);
      reset();
      onSent?.();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't send that email",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <>
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
        <DialogContent size="2xl" className="max-h-[92vh]">
          <DialogHeader>
            <DialogTitle>
              {context ? `Email ${context.client.name || context.client.email}` : "Send email"}
            </DialogTitle>
            <DialogDescription>
              {effectiveOrderNumber
                ? `Attributed to order ${effectiveOrderNumber}. Client and order details fill themselves in.`
                : "Write from scratch or start from a template — client details fill themselves in."}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4 overflow-y-auto">
            {contextError ? (
              <Alert variant="destructive">
                <AlertDescription>{contextError}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("to")}>To</Label>
                <Input
                  id={fieldId("to")}
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  maxLength={254}
                  disabled={sending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("order")}>
                  Related order{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                {lockedOrderId ? (
                  <div className="flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-[13px] text-muted-foreground">
                    {lockedOrderNumber ?? "This order"}
                  </div>
                ) : (
                  <Select
                    value={orderId}
                    onValueChange={setOrderId}
                    disabled={sending || loadingContext}
                  >
                    <SelectTrigger id={fieldId("order")}>
                      <SelectValue placeholder="Not related to an order" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_ORDER}>
                        Not related to an order
                      </SelectItem>
                      {(context?.orders ?? []).map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.orderNumber} · {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Toolbar. Everything here is optional — a blank email needs
                none of it, which is why nothing gates the composer. */}
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-2 py-2">
              <TemplateMenu
                templates={context?.templates ?? []}
                loading={loadingContext}
                activeKey={templateKey}
                onPick={applyTemplate}
                onClear={() => setTemplateKey(null)}
              />
              <InsertVariableMenu
                availability={availability}
                onInsert={insertText}
                disabled={sending}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setAttachOpen(true)}
                disabled={sending}
              >
                <PaperclipIcon className="size-3.5" />
                Attach file
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setLinkOpen(true)}
                disabled={sending}
              >
                <LinkIcon className="size-3.5" />
                Insert link
              </Button>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as "write" | "preview")}>
              <TabsList>
                <TabsTrigger value="write">Write</TabsTrigger>
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>

              <TabsContent value="write" className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("subject")}>Subject</Label>
                  <Input
                    id={fieldId("subject")}
                    ref={subjectRef}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    onFocus={() => (lastFocused.current = "subject")}
                    placeholder="Update on {{order_name}}"
                    maxLength={200}
                    disabled={sending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("body")}>Message</Label>
                  <Textarea
                    id={fieldId("body")}
                    ref={bodyRef}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onFocus={() => (lastFocused.current = "body")}
                    rows={14}
                    maxLength={20_000}
                    placeholder={`Hi ${context?.client.name?.split(" ")[0] ?? "there"},\n\n`}
                    disabled={sending}
                    className="min-h-[280px]"
                  />
                </div>

                {manualVars.length > 0 ? (
                  <div className="space-y-2 rounded-md border border-border bg-surface-1 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Details for this email
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {manualVars.map((v) => (
                        <div key={v.token} className="space-y-1">
                          <Label
                            htmlFor={fieldId(`var-${v.token}`)}
                            className="text-[11.5px]"
                          >
                            {v.label}
                          </Label>
                          <Input
                            id={fieldId(`var-${v.token}`)}
                            value={manual[v.token] ?? ""}
                            onChange={(e) =>
                              setManual((m) => ({
                                ...m,
                                [v.token]: e.target.value,
                              }))
                            }
                            placeholder={v.placeholder ?? v.sample}
                            maxLength={2000}
                            disabled={sending}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {attachments.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Attachments · {formatFileSize(attachmentBytes)}
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {attachments.map((file) => (
                        <li
                          key={file.id}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11.5px]"
                        >
                          <FileTextIcon className="size-3 text-muted-foreground" />
                          <span className="max-w-[220px] truncate">
                            {file.fileName}
                          </span>
                          <span className="text-muted-foreground">
                            {formatFileSize(file.sizeBytes)}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.fileName}`}
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              setAttachments((prev) =>
                                prev.filter((f) => f.id !== file.id),
                              )
                            }
                          >
                            <XIcon className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent value="preview">
                <div className="flex items-center justify-between pb-2">
                  <p className="text-[12px] text-muted-foreground">
                    Exactly what {context?.client.name || "your client"} will
                    receive.
                  </p>
                  {previewLoading ? (
                    <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                {!canPreview ? (
                  <p className="rounded-lg border border-dashed border-border bg-card/40 px-3 py-10 text-center text-[12.5px] text-muted-foreground">
                    Add a subject and a message to see the preview.
                  </p>
                ) : previewError ? (
                  <Alert variant="destructive">
                    <AlertDescription>{previewError}</AlertDescription>
                  </Alert>
                ) : previewHtml ? (
                  <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
                    <iframe
                      title="Email preview"
                      srcDoc={previewHtml}
                      className="block h-[520px] w-full border-0 bg-white"
                      sandbox="allow-same-origin"
                    />
                  </div>
                ) : (
                  <Skeleton className="h-[520px] w-full rounded-lg" />
                )}
              </TabsContent>
            </Tabs>
          </DialogBody>

          <DialogFooter className="items-center">
            <p className="mr-auto hidden text-[11.5px] text-muted-foreground sm:block">
              {attachments.length > 0
                ? `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} · saved to this client's Files`
                : "Sent from your workspace's email address."}
            </p>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <LoadingButton
              onClick={handleSend}
              loading={sending}
              loadingText="Sending"
              disabled={sending || !subject.trim() || !body.trim()}
            >
              <SendIcon className="size-3.5" />
              Send email
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AttachmentPicker
        open={attachOpen}
        onOpenChange={setAttachOpen}
        customerId={customerId}
        orderId={orderId === NO_ORDER ? null : orderId}
        orderNumber={effectiveOrderNumber}
        selected={attachments}
        onConfirm={setAttachments}
      />
      <LinkPicker
        open={linkOpen}
        onOpenChange={setLinkOpen}
        customerId={customerId}
        orderId={orderId === NO_ORDER ? null : orderId}
        orderNumber={effectiveOrderNumber}
        onInsert={handleInsertLink}
      />
    </>
  );
}

function TemplateMenu({
  templates,
  loading,
  activeKey,
  onPick,
  onClear,
}: {
  templates: ComposeContextDTO["templates"];
  loading: boolean;
  activeKey: string | null;
  onPick: (key: string) => void;
  onClear: () => void;
}) {
  const active = templates.find((t) => t.templateKey === activeKey);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={active ? "default" : "outline"}
          size="sm"
          className={cn("gap-1.5", active && "max-w-[240px]")}
          disabled={loading}
        >
          <FileTextIcon className="size-3.5" />
          <span className="truncate">
            {active ? active.displayName : "Use template"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[360px] overflow-y-auto">
        <DropdownMenuLabel>Your templates</DropdownMenuLabel>
        {templates.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-muted-foreground">
            No custom templates yet. Create one under Admin → Email templates,
            or just write this email.
          </div>
        ) : (
          templates.map((t) => (
            <DropdownMenuItem
              key={t.templateKey}
              onSelect={() => onPick(t.templateKey)}
              className="flex-col items-start gap-0"
            >
              <span>{t.displayName}</span>
              {t.description ? (
                <span className="text-[10.5px] text-muted-foreground">
                  {t.description}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        )}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear}>
              Stop tracking this template
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
