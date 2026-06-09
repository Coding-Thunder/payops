import { CaseFileCanvas } from "../mocks/case-file-canvas";
import { OutcomeVariantsStrip } from "../mocks/outcome-variants";

/**
 * Evidence region, opens the document.
 *
 * Two visual layers: prose + margin notes set the framing, then the
 * embedded case-file canvas IS the product surface. Below the canvas,
 * a strip of the four polymorphic outcome panels makes it explicit
 * that dispute-readiness is the everyday state, most orders sit at
 * READY, with OPEN / WON / LOST lighting up when a dispute happens.
 */
export function EvidenceRegion() {
  return (
    <section id="evidence" className="scroll-mt-20 pt-14 sm:pt-20">
      <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <p className="text-[15.5px] leading-relaxed text-foreground">
            Every order opens a case file the moment it&apos;s created.
            Items, customer, gateway selection, consent signature, every
            email, every gateway round-trip, all written into a hashed
            chain as they happen.
          </p>
          <p className="mt-3 text-[15.5px] leading-relaxed text-foreground">
            When a dispute arrives, weeks later, the artifact is
            already built. The operator clicks{" "}
            <span className="font-mono text-[14px]">Export PDF</span>{" "}
            and forwards a bank-grade document, the one rendered below
            is the actual surface, not a marketing facsimile.
          </p>
        </div>

        <aside className="lg:pt-1.5">
          <MarginNote
            tone="success"
            label="Captured inline"
            body="Every transition writes one chain row. No assembly step at dispute time."
          />
          <MarginNote
            tone="warning"
            label="Frozen on dispute"
            body="charge.dispute.created flips the risk flag, freezes the chain, stages the export."
          />
          <MarginNote
            tone="info"
            label="Same artifact in app + PDF"
            body="What the operator sees is what the bank receives. No template drift."
          />
        </aside>
      </div>

      <div className="mt-12">
        <CaseFileCanvas />
      </div>

      {/* Outcome variants, four states the same dispute outcome
          panel renders, side-by-side. Reads as the operational
          ground truth: most orders sit at READY. */}
      <div className="mt-14">
        <div className="mb-5 flex items-baseline justify-between border-b border-border pb-2">
          <h3 className="text-[12.5px] font-semibold tracking-tight">
            Same panel, four states
          </h3>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            READY · OPEN · WON · LOST
          </span>
        </div>
        <OutcomeVariantsStrip />
        <p className="mt-4 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
          Most orders sit at READY. OPEN lights up when a chargeback
          arrives; WON or LOST when the bank decides. Same shell, four
          variants, no separate dispute surface to navigate.
        </p>
      </div>
    </section>
  );
}

function MarginNote({
  tone,
  label,
  body,
}: {
  tone: "success" | "warning" | "info";
  label: string;
  body: string;
}) {
  const labelClass =
    tone === "success"
      ? "text-success-strong"
      : tone === "warning"
        ? "text-warning-foreground"
        : "text-info";
  const borderColor =
    tone === "success"
      ? "var(--success-border)"
      : tone === "warning"
        ? "var(--warning-border)"
        : "var(--info-border)";
  return (
    <div
      className="mb-3 border-l py-1.5 pl-3 last:mb-0"
      style={{ borderColor }}
    >
      <p
        className={`font-mono text-[10.5px] uppercase tracking-[0.14em] ${labelClass}`}
      >
        {label}
      </p>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
