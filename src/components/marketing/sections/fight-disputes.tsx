import { MarketingSection, AccentWord } from "../section";
import { CaseFileCanvas } from "../mocks/case-file-canvas";

/**
 * Disputes chapter — the brand center.
 *
 * Embeds the actual TraceTxn case-file artifact (a static React mock
 * of the in-app evidence document) instead of a screenshot. The
 * product surface IS the marketing artifact; visitors read the same
 * document operators send to banks.
 *
 * The supporting column (right) carries the framing — what the
 * artifact captures, when it captures it, and why it stays valid
 * six weeks after the order.
 */
export function FightDisputes() {
  return (
    <MarketingSection
      id="disputes"
      theme="orange"
      eyebrow="Built for disputes that arrive six weeks late"
      title={
        <>
          When the chargeback lands, the{" "}
          <AccentWord>evidence is already filed.</AccentWord>
        </>
      }
      description="Banks want proof you delivered, the customer agreed, and the charge matches the order. Every order persists a hashed, append-only case file — contesting a chargeback is a click, not a forensic exercise."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start">
        {/* Live case-file canvas — the product surface, not a screenshot */}
        <div data-reveal data-reveal-order={0} className="lg:sticky lg:top-32">
          <CaseFileCanvas />
        </div>

        {/* Editorial column: what's captured, when, why it lands */}
        <div className="space-y-8">
          <Note
            order={0}
            label="01"
            title="Captured inline, not assembled later"
            body="Every transition writes one row into the hashed chain — order created, link generated, email sent, consent signed, paid. The case file is built by the time the customer hits success."
          />
          <Note
            order={1}
            label="02"
            title="Frozen the moment a dispute opens"
            body={
              <>
                The first{" "}
                <code className="font-mono text-[12px]">
                  charge.dispute.created
                </code>{" "}
                webhook flips the order risk flag, freezes the chain, and
                stages a one-click export. The bank's evidence deadline
                stops being a fire drill.
              </>
            }
          />
          <Note
            order={2}
            label="03"
            title="The export and the in-app view are the same artifact"
            body="Operators view the case file in TraceTxn; banks receive the PDF export. Same skeleton, same data, same chain head hash — no separate template, no representation drift."
          />
          <Note
            order={3}
            label="04"
            title="Tamper-proof by design"
            body="Every event chain-hashes the previous one's payload. Any edit cascades into a broken chain that surfaces immediately to the operator and the regulator. The data model is the audit."
          />
        </div>
      </div>
    </MarketingSection>
  );
}

function Note({
  order,
  label,
  title,
  body,
}: {
  order: number;
  label: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div
      data-reveal
      data-reveal-order={order + 1}
      className="grid grid-cols-[2.25rem_1fr] items-baseline gap-x-3"
    >
      <span
        className="font-mono text-[10.5px] uppercase tracking-[0.14em]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {label}
      </span>
      <div className="space-y-1.5">
        <h3 className="text-[15.5px] font-semibold tracking-tight">
          {title}
        </h3>
        <p
          className="text-[13.5px] leading-relaxed"
          style={{ color: "var(--m-fg-soft)" }}
        >
          {body}
        </p>
      </div>
    </div>
  );
}
