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
                viewBox="0 0 64 64"
                className="size-4"
                aria-hidden
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M19 16h15.5c6.6 0 11.5 4.5 11.5 11s-4.9 11-11.5 11H26v13h-7V16zm7 16h7.5c3 0 5-2 5-5s-2-5-5-5H26v10z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              PayOps
            </span>
            <span
              className="ml-3 text-[12.5px]"
              style={{ color: "var(--m-fg-soft)" }}
            >
              · payment operations · privately deployed
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
