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
import type { EmailTemplateKey } from "@/lib/constants/email-templates";
import { cn } from "@/lib/utils";
import type { EmailTemplateVersionDTO } from "@/types";

interface TemplateOption {
  key: EmailTemplateKey;
  label: string;
}

interface AdminTemplateEditorProps {
  templateKey: EmailTemplateKey;
  templates: readonly TemplateOption[];
  versions: EmailTemplateVersionDTO[];
  activeVersion: EmailTemplateVersionDTO | null;
  initialHtml: string;
}

interface DraftState {
  subject: string;
  greeting: string;
  intro: string;
  note: string;
  supportHeadline: string;
  supportDescription: string;
  footerNote: string;
}

const EMPTY_DRAFT: DraftState = {
  subject: "",
  greeting: "",
  intro: "",
  note: "",
  supportHeadline: "",
  supportDescription: "",
  footerNote: "",
};

function draftFromVersion(version: EmailTemplateVersionDTO | null): DraftState {
  if (!version) return EMPTY_DRAFT;
  return {
    subject: version.subject ?? "",
    greeting: version.greeting ?? "",
    intro: version.intro ?? "",
    note: version.note ?? "",
    supportHeadline: version.supportHeadline ?? "",
    supportDescription: version.supportDescription ?? "",
    footerNote: version.footerNote ?? "",
  };
}

const DEBOUNCE_MS = 350;

/**
 * Versioned no-code editor for the email-template content.
 *
 * Save → creates a new immutable version and activates it. Past versions
 * stay in the history list; clicking "Activate this version" rolls
 * back. Live iframe preview reflects the editor's current draft.
 */
export function AdminTemplateEditor({
  templateKey,
  templates,
  versions,
  activeVersion,
  initialHtml,
}: AdminTemplateEditorProps) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<DraftState>(() =>
    draftFromVersion(activeVersion),
  );
  const [html, setHtml] = React.useState(initialHtml);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [pendingActivateId, setPendingActivateId] = React.useState<string | null>(
    null,
  );

  // Reset the draft if the parent re-renders with a new active version
  // (e.g. after activating a historical version).
  const lastActiveId = React.useRef(activeVersion?.id ?? null);
  React.useEffect(() => {
    const currentId = activeVersion?.id ?? null;
    if (currentId !== lastActiveId.current) {
      lastActiveId.current = currentId;
      setDraft(draftFromVersion(activeVersion));
    }
  }, [activeVersion]);

  // Debounced preview render, same endpoint the no-save preview uses.
  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const { html: rendered } = await api.post<{ html: string }>(
          `/api/admin/email-templates/${templateKey}/preview`,
          draftPayload(draft),
          { signal: controller.signal },
        );
        setHtml(rendered);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(
          err instanceof ApiClientError
            ? err.message
            : "Couldn't render preview",
        );
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, templateKey]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.post(`/api/admin/email-templates/${templateKey}`, draftPayload(draft));
      toast.success("Saved as a new version");
      router.refresh();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Couldn't save version";
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
      const msg =
        err instanceof ApiClientError ? err.message : "Couldn't activate version";
      toast.error(msg);
    } finally {
      setPendingActivateId(null);
    }
  }

  function handleResetToActive() {
    setDraft(draftFromVersion(activeVersion));
  }

  const isDirty = React.useMemo(() => {
    const base = draftFromVersion(activeVersion);
    return (Object.keys(base) as Array<keyof DraftState>).some(
      (key) => base[key] !== draft[key],
    );
  }, [draft, activeVersion]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,460px)_1fr]">
      <aside className="space-y-4">
        <TemplateSwitcher
          templateKey={templateKey}
          templates={templates}
          activeVersionLabel={activeVersion?.version ?? null}
          totalVersions={versions.length}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] tracking-tight">
              Editable content
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Subject" hint="Falls back to the system default when blank.">
              <Input
                value={draft.subject}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, subject: e.target.value }))
                }
                maxLength={200}
              />
            </Field>
            <Field
              label="Greeting"
              hint="The “Hi {name},” line. Leave blank to keep the default."
            >
              <Input
                value={draft.greeting}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, greeting: e.target.value }))
                }
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
                onChange={(e) =>
                  setDraft((d) => ({ ...d, intro: e.target.value }))
                }
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
                onChange={(e) =>
                  setDraft((d) => ({ ...d, note: e.target.value }))
                }
                maxLength={2000}
              />
            </Field>
            <Field
              label="Support headline"
              hint="Bold label for the support block."
            >
              <Input
                value={draft.supportHeadline}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, supportHeadline: e.target.value }))
                }
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
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    supportDescription: e.target.value,
                  }))
                }
                maxLength={2000}
              />
            </Field>
            <Field
              label="Footer note"
              hint="Optional extra line shown above the copyright."
            >
              <Textarea
                rows={2}
                value={draft.footerNote}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, footerNote: e.target.value }))
                }
                maxLength={500}
              />
            </Field>
          </CardContent>
        </Card>

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
            disabled={!isDirty}
          >
            <SaveIcon className="size-3.5" />
            Save as new version
          </LoadingButton>
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
        </div>
        <p className="text-[11px] text-muted-foreground">
          Saving creates a new immutable version and activates it. Old
          versions stay in history below, you can roll back at any time.
        </p>

        <VersionsList
          versions={versions}
          pendingActivateId={pendingActivateId}
          onActivate={handleActivate}
        />
      </aside>

      <section className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight">Preview</h2>
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
  templateKey: EmailTemplateKey;
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
                  {v.createdBy.name} · {new Date(v.createdAt).toLocaleString()}
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
