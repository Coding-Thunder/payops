"use client";

import * as React from "react";

/**
 * The console's confirmation dialog for destructive/consequential actions.
 *
 * Replaces `window.confirm`, which the eight destructive call sites used.
 * Native confirm can't show context (which user? which order?), can't render
 * a loading state, is styled by the OS rather than the console, and is
 * suppressible by the browser — so an operator can end up with a
 * "disable user" button that silently does nothing, or one that fires twice.
 *
 * Built on <dialog>: the platform gives modality, Escape-to-close, focus
 * containment and the top-layer for free, which is a smaller and more correct
 * surface than hand-rolling a focus trap.
 */
export interface ConfirmOptions {
  title: string;
  /** Body copy. Say what will happen, and to whom. */
  body?: React.ReactNode;
  /** Label for the confirming button. Name the action, never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red treatment for irreversible/destructive actions. */
  tone?: "danger" | "default";
}

export function ConfirmDialog({
  open,
  options,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  options: ConfirmOptions | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Focus the confirming action, not the dialog container, so Enter works
      // immediately and screen readers announce the consequence first.
      confirmRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  if (!options) return null;
  const danger = options.tone === "danger";

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      // Escape fires `cancel`; route it through the same path as the button so
      // a dismissal can never leave `busy` stuck on.
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(28rem,92vw)] rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-0 text-slate-200 backdrop:bg-black/60"
    >
      <div className="p-5">
        <h2 id="confirm-title" className="text-base font-semibold text-slate-100">
          {options.title}
        </h2>
        {options.body ? (
          <div className="mt-2 text-[13px] text-[var(--muted)]">{options.body}</div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-slate-200 hover:bg-white/5 disabled:opacity-50"
          >
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 ${
              danger
                ? "bg-red-600 hover:bg-red-500"
                : "bg-[var(--accent)] hover:bg-[var(--accent-2)]"
            }`}
          >
            {busy ? "Working…" : (options.confirmLabel ?? "Confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * Drives a ConfirmDialog and runs the confirmed action.
 *
 * The `busy` flag is the double-submit guard: `run()` refuses to start a
 * second attempt while one is in flight, which the old `confirm()` sites had
 * no protection against.
 */
export function useConfirm() {
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const actionRef = React.useRef<null | (() => Promise<void> | void)>(null);

  const confirm = React.useCallback(
    (opts: ConfirmOptions, action: () => Promise<void> | void) => {
      setError(null);
      setOptions(opts);
      actionRef.current = action;
    },
    [],
  );

  const cancel = React.useCallback(() => {
    if (busy) return;
    setOptions(null);
    setError(null);
    actionRef.current = null;
  }, [busy]);

  const onConfirm = React.useCallback(async () => {
    if (busy || !actionRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await actionRef.current();
      setOptions(null);
      actionRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const dialog = (
    <ConfirmDialog
      open={options !== null}
      options={options}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={cancel}
    />
  );

  return { confirm, dialog, busy };
}
