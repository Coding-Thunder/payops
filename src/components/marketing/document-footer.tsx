/**
 * Document footer — the final closing strip.
 *
 * Reads as the bottom-of-document footer of an exported artifact, not
 * a sitewide marketing footer. One line of wordmark + tagline +
 * year. No nav, no columns of links.
 */
export function DocumentFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-[1280px] flex-col items-start justify-between gap-3 px-6 py-6 sm:flex-row sm:items-center sm:px-10">
        <div className="inline-flex items-center gap-2.5">
          <span className="grid size-5 place-items-center rounded-[4px] bg-foreground text-background">
            <svg
              viewBox="0 0 48 48"
              className="size-3"
              aria-hidden
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect
                x="10"
                y="13"
                width="28"
                height="5"
                rx="2.5"
                fill="currentColor"
              />
              <rect
                x="21.5"
                y="13"
                width="5"
                height="24"
                rx="2.5"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="text-[12.5px] font-semibold tracking-tight">
            TraceTxn
          </span>
          <span className="text-[11.5px] text-muted-foreground">
            Operational visibility · dispute readiness
          </span>
        </div>
        <p className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          © {year} · v1.0
        </p>
      </div>
    </footer>
  );
}
