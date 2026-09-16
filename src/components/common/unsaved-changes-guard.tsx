"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/common/confirm-dialog";

interface UnsavedChangesGuardOptions {
  /** True while there is something that leaving would throw away. */
  when: boolean;
  /**
   * True while the edits are being saved. Navigation is held without
   * offering "discard": the save is already on its way and will move the
   * page itself, so a discard prompt there would promise something that
   * cannot happen.
   */
  busy?: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

/**
 * Stops an operator losing edits by leaving the page.
 *
 * The App Router has no router-level way to veto a navigation
 * (`router.events` went with the Pages Router), so this covers the exits
 * that can actually be intercepted:
 *
 *   - reload, tab close, typing a URL — `beforeunload`, which shows the
 *     browser's own prompt;
 *   - any in-app link, including the sidebar and the page's own "back"
 *     link — a capture-phase click listener on `window`. It runs before
 *     React's handlers, so cancelling the event here also stops Next's
 *     `<Link>` from navigating;
 *   - the page's own buttons — `requestLeave(href)`.
 *
 * Not covered, by design: the browser's back/forward buttons (a `popstate`
 * cannot be cancelled, and faking it by rewriting history is worse than the
 * problem) and programmatic `router.push` calls from elsewhere, such as the
 * command palette. The `beforeunload` prompt does not fire for those either.
 */
export function useUnsavedChangesGuard({
  when,
  busy = false,
  title = "Discard unsaved changes?",
  description = "You have edits on this page that have not been saved. Leaving now will lose them.",
  confirmLabel = "Discard changes",
}: UnsavedChangesGuardOptions) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  // Set once the edits are saved or deliberately discarded, so the
  // navigation that follows is not itself intercepted.
  const releasedRef = React.useRef(false);
  const busyRef = React.useRef(busy);
  React.useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  React.useEffect(() => {
    if (!when) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (releasedRef.current) return;
      event.preventDefault();
      // Still required by some browsers to show the prompt.
      event.returnValue = "";
    };

    const onClick = (event: MouseEvent) => {
      if (releasedRef.current || event.defaultPrevented) return;
      // Let the browser handle "open in new tab/window" — nothing is lost.
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      // Another origin is a full unload, which `beforeunload` already covers.
      if (url.origin !== window.location.origin) return;
      // A hash jump on this same page loses nothing.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (busyRef.current) return;
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [when]);

  /** Navigate to `href`, asking first if there are unsaved edits. */
  const requestLeave = React.useCallback(
    (href: string) => {
      if (busyRef.current) return;
      if (!when || releasedRef.current) {
        router.push(href);
        return;
      }
      setPendingHref(href);
    },
    [when, router],
  );

  /** Mark the edits as handled (saved) so the next navigation goes through. */
  const release = React.useCallback(() => {
    releasedRef.current = true;
  }, []);

  const dialog = (
    <ConfirmDialog
      open={pendingHref !== null}
      onOpenChange={(open) => {
        if (!open) setPendingHref(null);
      }}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel="Keep editing"
      tone="warning"
      onConfirm={() => {
        const href = pendingHref;
        releasedRef.current = true;
        setPendingHref(null);
        if (href) router.push(href);
      }}
    />
  );

  return { requestLeave, release, dialog };
}
