import { CaseFileCanvas } from "../mocks/case-file-canvas";

/**
 * Evidence region — embeds the case-file artifact as the document
 * opening. No section eyebrow, no AccentWord. The first sentence
 * reads as a document opening line; the artifact follows; a thin
 * column of margin notes runs alongside it.
 *
 * The region is anchored as #evidence — the document rail tracks
 * scroll position against it.
 */
export function EvidenceRegion() {
  return (
    <section id="evidence" className="scroll-mt-20 pt-14 sm:pt-20">
      <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <p className="text-[15.5px] leading-relaxed text-foreground">
            Every order opens a case file the moment it&apos;s created.
            Items, customer, gateway selection, consent signature, every
            email, every gateway round-trip — all written into a hashed
            chain as they happen.
          </p>
          <p className="mt-3 text-[15.5px] leading-relaxed text-foreground">
            When a dispute arrives, weeks later, the artifact is
            already built. The operator clicks{" "}
            <span className="font-mono text-[14px]">Export PDF</span>{" "}
            and forwards a bank-grade document — the one rendered below
            is the actual surface, not a marketing facsimile.
          </p>
        </div>

        <aside className="lg:pt-1.5">
          <MarginNote
            label="Captured inline"
            body="Every transition writes one chain row. No assembly step at dispute time."
          />
          <MarginNote
            label="Frozen on dispute"
            body="charge.dispute.created flips the risk flag, freezes the chain, stages the export."
          />
          <MarginNote
            label="Same artifact in app + PDF"
            body="What the operator sees is what the bank receives. No template drift."
          />
        </aside>
      </div>

      <div className="mt-12">
        <CaseFileCanvas />
      </div>
    </section>
  );
}

function MarginNote({ label, body }: { label: string; body: string }) {
  return (
    <div className="border-l border-border/70 py-1.5 pl-3 mb-3 last:mb-0">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-success">
        {label}
      </p>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
