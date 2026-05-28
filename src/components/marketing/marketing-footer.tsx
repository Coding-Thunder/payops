/**
 * Marketing footer — intentionally minimal. Inherits the cream
 * theme so the page exits the closing chapter without a tone shift.
 */
export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer
      data-theme="closing"
      className="relative isolate py-12"
      style={{ borderTop: "1px solid var(--m-border)" }}
    >
      <div className="mx-auto w-full max-w-[1280px] px-6 lg:px-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="inline-flex items-center gap-2.5">
            <span
              className="grid size-7 place-items-center rounded-md"
              style={{
                background: "var(--m-ink)",
                color: "white",
              }}
            >
              <svg
                viewBox="0 0 48 48"
                className="size-4"
                aria-hidden
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="10" y="13" width="28" height="5" rx="2.5" fill="currentColor" />
                <rect x="21.5" y="13" width="5" height="24" rx="2.5" fill="currentColor" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              TraceTxn
            </span>
            <span
              className="ml-3 text-[12.5px]"
              style={{ color: "var(--m-fg-soft)" }}
            >
              · payment operations · multi-tenant by design
            </span>
          </div>

          <p
            className="font-mono text-[11px] uppercase tracking-[0.18em]"
            style={{ color: "var(--m-fg-soft)" }}
          >
            © {year} · v1.0
          </p>
        </div>
      </div>
    </footer>
  );
}
