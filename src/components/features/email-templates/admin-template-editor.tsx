"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  Loader2Icon,
  RotateCcwIcon,
  SaveIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { manualVariablesUsed } from "@/lib/constants/email-variables";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EmailTemplateVersionDTO } from "@/types";

import {
  InsertVariableMenu,
  focusCaret,
  insertAtCaret,
} from "./insert-variable-menu";

interface TemplateOption {
  key: string;
  label: string;
}

interface AdminTemplateEditorProps {
  /** Either a SYSTEM_EMAIL_TEMPLATE_KEYS entry or a tenant-defined
   *  custom slug. Absent in create mode — the server derives the key
   *  from the name on save. */
  templateKey?: string;
  /** System templates are code-rendered layouts with named copy slots;
   *  custom ones are a written email. The editor is a different shape
   *  for each, so this is the top-level branch. */
  kind: "system" | "custom";
  displayName: string;
  templates?: readonly TemplateOption[];
  versions?: EmailTemplateVersionDTO[];
  activeVersion?: EmailTemplateVersionDTO | null;
  initialHtml: string;
  /** Create mode: no key yet, POST to the create endpoint on save. */
  mode?: "edit" | "create";
}

interface DraftState {
  displayName: string;
  description: string;
  subject: string;
  body: string;
  greeting: string;
  intro: string;
  note: string;
  supportHeadline: string;
  supportDescription: string;
  footerNote: string;
}

function emptyDraft(displayName = ""): DraftState {
  return {
    displayName,
    description: "",
    subject: "",
    body: "",
    greeting: "",
    intro: "",
    note: "",
    supportHeadline: "",
    supportDescription: "",
    footerNote: "",
  };
}

function draftFromVersion(
  version: EmailTemplateVersionDTO | null | undefined,
  fallbackName: string,
): DraftState {
  if (!version) return emptyDraft(fallbackName);
  return {
    displayName: version.displayName ?? fallbackName,
    description: version.description ?? "",
    subject: version.subject ?? "",
    body: version.body ?? "",
    greeting: version.greeting ?? "",
    intro: version.intro ?? "",
    note: version.note ?? "",
    supportHeadline: version.supportHeadline ?? "",
    supportDescription: version.supportDescription ?? "",
    footerNote: version.footerNote ?? "",
  };
}

const DEBOUNCE_MS = 400;

/**
 * The template editor: content on the left, live preview on the right.
 *
 * Two shapes, one component, because they're the same job:
 *
 *   custom  — Name, Subject, and the email itself. That's the whole
 *             form. No key to invent, no seven-slot content grid to
 *             reverse-engineer into a message.
 *   system  — the named copy slots of a code-rendered transactional
 *             layout (greeting / intro / note / support / footer). The
 *             layout is fixed because it's what the payment flow sends;
 *             only the words are yours.
 *
 * The preview is rendered by the SAME server function the saved
 * template renders through, so what's on the right is what goes out.
 */
export function AdminTemplateEditor({
  templateKey,
  kind,
  displayName,
  templates = [],
  versions = [],
  activeVersion = null,
  initialHtml,
  mode = "edit",
}: AdminTemplateEditorProps) {
  const router = useRouter();
  const isCreate = mode === "create";
  const isCustom = kind === "custom";

  const [draft, setDraft] = React.useState<DraftState>(() =>
    isCreate ? emptyDraft("") : draftFromVersion(activeVersion, displayName),
  );
  const [html, setHtml] = React.useState(initialHtml);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [pendingActivateId, setPendingActivateId] = React.useState<string | null>(
    null,
  );
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const lastFocused = React.useRef<"subject" | "body">("body");

  // Reset the draft if the parent re-renders with a new active version
  // (e.g. after activating a historical version).
  const lastActiveId = React.useRef(activeVersion?.id ?? null);
  React.useEffect(() => {
    if (isCreate) return;
    const currentId = activeVersion?.id ?? null;
    if (currentId !== lastActiveId.current) {
      lastActiveId.current = currentId;
      setDraft(draftFromVersion(activeVersion, displayName));
    }
  }, [activeVersion, displayName, isCreate]);

  // Debounced live preview.
  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const endpoint = isCreate
          ? "/api/admin/email-templates/preview"
          : `/api/admin/email-templates/${templateKey}/preview`;
        const payload = isCreate
          ? {
              displayName: draft.displayName || "New template",
              subject: draft.subject.trim() || null,
              body: draft.body.trim() || null,
            }
          : draftPayload(draft);
        const { html: rendered } = await api.post<{ html: string }>(
          endpoint,
          payload,
          { signal: controller.signal },
        );
        setHtml(rendered);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof ApiClientError ? err.message : "Couldn't render preview",
        );
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, templateKey, isCreate]);

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function handleInsert(token: string) {
    const target = lastFocused.current;
    if (target === "subject") {
      const { value, caret } = insertAtCaret(
        subjectRef.current,
        draft.subject,
        token,
      );
      set("subject", value.slice(0, 200));
      focusCaret(subjectRef.current, caret);
      return;
    }
    const { value, caret } = insertAtCaret(bodyRef.current, draft.body, token);
    set("body", value);
    focusCaret(bodyRef.current, caret);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      if (isCreate) {
        if (draft.displayName.trim().length < 2) {
          setSaveError("Give the template a name your team will recognise.");
          return;
        }
        const created = await api.post<{ templateKey: string; displayName: string }>(
          "/api/admin/email-templates/custom",
          {
            displayName: draft.displayName.trim(),
            description: draft.description.trim() || undefined,
            subject: draft.subject.trim() || null,
            body: draft.body.trim() || null,
          },
        );
        toast.success(`Created "${created.displayName}"`);
        router.push(`/app/admin/email-templates/${created.templateKey}`);
        router.refresh();
        return;
      }

      // A renamed custom template updates its metadata across every
      // version row, then saves the copy as a new version. Two calls
      // because they're two different kinds of change: the name is
      // registry metadata, the copy is versioned history.
      if (isCustom && draft.displayName.trim() !== displayName) {
        await api.patch(`/api/admin/email-templates/${templateKey}/rename`, {
          displayName: draft.displayName.trim(),
          description: draft.description.trim() || null,
        });
      }
      await api.post(
        `/api/admin/email-templates/${templateKey}`,
        draftPayload(draft),
      );
      toast.success("Saved as a new version");
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Couldn't save template";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(versionId: string) {
    setPendingActivateId(versionId);
    try {
      await api.post(
        `/api/admin/email-templates/${templateKey}/${versionId}/activate`,
      );
      toast.success("Version activated");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Couldn't activate version",
      );
    } finally {
      setPendingActivateId(null);
    }
  }

  function handleResetToActive() {
    setDraft(draftFromVersion(activeVersion, displayName));
  }

  const isDirty = React.useMemo(() => {
    if (isCreate) {
      return Boolean(draft.displayName.trim() || draft.subject.trim() || draft.body.trim());
    }
    const base = draftFromVersion(activeVersion, displayName);
    return (Object.keys(base) as Array<keyof DraftState>).some(
      (key) => base[key] !== draft[key],
    );
  }, [draft, activeVersion, displayName, isCreate]);

  // Legacy custom templates saved before the body field existed still
  // carry copy in the old slots. Keep those fields visible for THOSE
  // templates so their content stays editable, and hide them everywhere
  // else — a new template should never meet them.
  const hasLegacySlots = Boolean(
    isCustom &&
      !draft.body &&
      (draft.greeting || draft.intro || draft.note),
  );

  const manualVars = manualVariablesUsed(draft.subject, draft.body);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,480px)_1fr]">
      <aside className="space-y-4">
        {!isCreate && templates.length > 0 ? (
          <TemplateSwitcher
            templateKey={templateKey ?? ""}
            templates={templates}
            activeVersionLabel={activeVersion?.version ?? null}
            totalVersions={versions.length}
          />
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] tracking-tight">
              {isCustom ? "Template" : "Editable content"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isCustom ? (
              <>
                <Field
                  label="Template name"
                  hint="What your team sees when picking a template."
                >
                  <Input
                    value={draft.displayName}
                    onChange={(e) => set("displayName", e.target.value)}
                    placeholder="Project Update"
                    maxLength={120}
                    autoFocus={isCreate}
                  />
                </Field>
                <Field
                  label="When to use it"
                  hint="Optional one-liner for your team."
                >
                  <Input
                    value={draft.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="Weekly progress update for active projects."
                    maxLength={500}
                  />
                </Field>
              </>
            ) : null}

            <Field
              label="Subject"
              hint={
                isCustom
                  ? "Shown in the client's inbox. Variables work here too."
                  : "Falls back to the system default when blank."
              }
            >
              <Input
                ref={subjectRef}
                value={draft.subject}
                onChange={(e) => set("subject", e.target.value)}
                onFocus={() => (lastFocused.current = "subject")}
                placeholder={isCustom ? "Update on {{order_name}}" : undefined}
                maxLength={200}
              />
            </Field>

            {isCustom ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-foreground">
                    Email content
                  </span>
                  <InsertVariableMenu
                    // The editor has no client or order in hand, so every
                    // group is offerable here; what a given SEND can
                    // actually resolve is decided in the composer.
                    availability={{ order: true, payment: true }}
                    onInsert={handleInsert}
                  />
                </div>
                <Textarea
                  ref={bodyRef}
                  rows={16}
                  value={draft.body}
                  onChange={(e) => set("body", e.target.value)}
                  onFocus={() => (lastFocused.current = "body")}
                  maxLength={20_000}
                  placeholder={
                    "Hello {{client_name}},\n\nHere is an update regarding {{order_name}}.\n\n{{project_update}}\n\nNext up: {{next_step}}\n\nThanks,\n{{sender_name}}"
                  }
                  className="min-h-[280px] font-normal"
                />
                <p className="text-[11px] text-muted-foreground">
                  Blank lines start new paragraphs. Pasted links become
                  clickable. Use <span className="font-medium">Insert</span> to
                  add details that change per client.
                </p>
              </div>
            ) : null}

            {manualVars.length > 0 ? (
              <Alert>
                <AlertTitle className="text-[12px]">
                  Filled in when sending
                </AlertTitle>
                <AlertDescription className="text-[11.5px]">
                  {manualVars.map((v) => v.label).join(", ")} —{" "}
                  {manualVars.length === 1 ? "this one is" : "these are"} asked
                  for in the composer, so the same template works for every
                  client.
                </AlertDescription>
              </Alert>
            ) : null}

            {!isCustom || hasLegacySlots ? (
              <>
                {hasLegacySlots ? (
                  <p className="rounded-md bg-surface-1 px-3 py-2 text-[11.5px] text-muted-foreground">
                    This template was written before the email editor existed.
                    Its original copy is below — move it into{" "}
                    <span className="font-medium">Email content</span> whenever
                    you like.
                  </p>
                ) : null}
                <Field
                  label="Greeting"
                  hint="The &ldquo;Hi {name},&rdquo; line. Leave blank to keep the default."
                >
                  <Input
                    value={draft.greeting}
                    onChange={(e) => set("greeting", e.target.value)}
                    maxLength={200}
                  />
                </Field>
                <Field
                  label="Intro paragraph"
                  hint="The opening body copy under the heading."
                >
                  <Textarea
                    rows={4}
                    value={draft.intro}
                    onChange={(e) => set("intro", e.target.value)}
                    maxLength={2000}
                  />
                </Field>
                <Field
                  label="Optional note"
                  hint="Renders as a callout block above the support section."
                >
                  <Textarea
                    rows={3}
                    value={draft.note}
                    onChange={(e) => set("note", e.target.value)}
                    maxLength={2000}
                  />
                </Field>
              </>
            ) : null}

            {!isCustom ? (
              <>
                <Field
                  label="Support headline"
                  hint="Bold label for the support block."
                >
                  <Input
                    value={draft.supportHeadline}
                    onChange={(e) => set("supportHeadline", e.target.value)}
                    maxLength={200}
                  />
                </Field>
                <Field
                  label="Support description"
                  hint="Smaller paragraph under the support headline."
                >
                  <Textarea
                    rows={2}
                    value={draft.supportDescription}
                    onChange={(e) => set("supportDescription", e.target.value)}
                    maxLength={2000}
                  />
                </Field>
              </>
            ) : null}

            <Field
              label="Footer note"
              hint="Optional extra line shown above the copyright."
            >
              <Textarea
                rows={2}
                value={draft.footerNote}
                onChange={(e) => set("footerNote", e.target.value)}
                maxLength={500}
              />
            </Field>
          </CardContent>
        </Card>

        {saveError ? (
          <Alert variant="destructive">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        ) : null}
        {previewError ? (
          <Alert variant="destructive">
            <AlertTitle>Preview failed</AlertTitle>
            <AlertDescription>{previewError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center gap-2">
          <LoadingButton
            onClick={handleSave}
            loading={saving}
            loadingText={isCreate ? "Creating" : "Saving"}
            disabled={!isDirty}
          >
            <SaveIcon className="size-3.5" />
            {isCreate ? "Save template" : "Save as new version"}
          </LoadingButton>
          {isCreate ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetToActive}
              disabled={!isDirty}
            >
              <RotateCcwIcon className="size-3.5" />
              Reset
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {isCreate
            ? "We'll create the template and drop you into the editor to keep refining it."
            : "Saving creates a new immutable version and activates it. Old versions stay in history below, you can roll back at any time."}
        </p>

        {isCreate ? null : (
          <VersionsList
            versions={versions}
            pendingActivateId={pendingActivateId}
            onActivate={handleActivate}
          />
        )}
      </aside>

      <section className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Preview{isCustom ? " · sample client data" : ""}
          </h2>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em]",
              previewLoading ? "text-muted-foreground" : "text-muted-foreground/70",
            )}
          >
            {previewLoading ? <Loader2Icon className="size-3 animate-spin" /> : null}
            Live
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
          <iframe
            title="Template preview"
            srcDoc={html}
            className="block h-[860px] w-full border-0 bg-white"
            sandbox="allow-same-origin"
          />
        </div>
      </section>
    </div>
  );
}

function draftPayload(draft: DraftState) {
  // Empty strings → null so the server treats blanks as "use default".
  return {
    subject: draft.subject.trim() || null,
    body: draft.body.trim() || null,
    greeting: draft.greeting.trim() || null,
    intro: draft.intro.trim() || null,
    note: draft.note.trim() || null,
    supportHeadline: draft.supportHeadline.trim() || null,
    supportDescription: draft.supportDescription.trim() || null,
    footerNote: draft.footerNote.trim() || null,
  };
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

interface TemplateSwitcherProps {
  templateKey: string;
  templates: readonly TemplateOption[];
  activeVersionLabel: number | null;
  totalVersions: number;
}

function TemplateSwitcher({
  templateKey,
  templates,
  activeVersionLabel,
  totalVersions,
}: TemplateSwitcherProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Templates
        </p>
      </div>
      <ul className="divide-y divide-border">
        {templates.map((t) => {
          const active = t.key === templateKey;
          return (
            <li
              key={t.key}
              className={cn(
                "text-[13px] transition-colors",
                active ? "bg-muted/40" : "hover:bg-muted/20",
              )}
            >
              <Link
                href={`/app/admin/email-templates/${t.key}`}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="font-medium text-foreground">{t.label}</span>
                {active && activeVersionLabel != null ? (
                  <span className="text-[11px] text-muted-foreground">
                    v{activeVersionLabel} · {totalVersions} version
                    {totalVersions === 1 ? "" : "s"}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface VersionsListProps {
  versions: EmailTemplateVersionDTO[];
  pendingActivateId: string | null;
  onActivate: (id: string) => void;
}

function VersionsList({
  versions,
  pendingActivateId,
  onActivate,
}: VersionsListProps) {
  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="pt-5">
          <p className="text-[12px] text-muted-foreground">
            No saved versions yet, the email uses the system defaults.
            Save the editor above to create version 1.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[13px] tracking-tight">
          Version history
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-border">
          {versions.map((v) => (
            <li
              key={v.id}
              className={cn(
                "flex items-center justify-between gap-3 px-5 py-3 text-[12.5px]",
                v.active && "bg-muted/30",
              )}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium">
                  <span className="text-foreground">v{v.version}</span>
                  {v.active ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                      <CheckCircle2Icon className="size-3" />
                      Active
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {v.createdBy.name} · {formatDateTime(v.createdAt)}
                </p>
              </div>
              {v.active ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11.5px]"
                  onClick={() => onActivate(v.id)}
                  disabled={pendingActivateId !== null}
                >
                  {pendingActivateId === v.id ? "Activating…" : "Activate"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
