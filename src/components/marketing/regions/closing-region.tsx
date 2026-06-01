import { QuotationFormBody } from "../quotation-form-body";

/**
 * Closing region, the final enclosure of the document.
 *
 * Not a "contact section." A compressed footer-area moment that
 * reframes the form as the side door for custom / procurement work,
 * with the self-serve path explicitly pointed back to /signup.
 *
 * Composition: left = short reframe + direct line; right = bare
 * form. No sticky sidebar, no aside card chrome.
 */

interface ClosingRegionProps {
  turnstileSiteKey?: string | null;
}

export function ClosingRegion({ turnstileSiteKey }: ClosingRegionProps) {
  return (
    <section className="border-t border-border pt-16 pb-24">
      <div className="grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
        <div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            Side door
          </p>
          <h2 className="mt-3 max-w-[20ch] text-balance text-[22px] sm:text-[26px] font-semibold leading-[1.15] tracking-[-0.018em]">
            For custom, high-volume, or procurement-led setups.
          </h2>
          <p className="mt-4 max-w-[42ch] text-[14px] leading-relaxed text-muted-foreground">
            Most teams{" "}
            <a
              href="/signup"
              className="underline underline-offset-2 decoration-foreground/30 transition-colors hover:decoration-foreground"
            >
              start free
            </a>{" "}
            and grow from there. If you need scoped routing, regional
            gateway selection, a procurement track, or volumes that
            warrant a dedicated conversation, tell us about it and
            we&apos;ll respond within one business day.
          </p>

          <div className="mt-7">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Direct line
            </p>
            <a
              href="mailto:vinaymaheshwari35@gmail.com?subject=TraceTxn%20%E2%80%94%20requirements"
              className="mt-1.5 inline-block text-[14.5px] font-medium text-foreground hover:underline underline-offset-2 decoration-foreground/30"
            >
              vinaymaheshwari35@gmail.com
            </a>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Reaches the team building and operating TraceTxn. No drip,
              no SDR.
            </p>
          </div>
        </div>

        <div>
          <QuotationFormBody turnstileSiteKey={turnstileSiteKey} />
        </div>
      </div>
    </section>
  );
}
