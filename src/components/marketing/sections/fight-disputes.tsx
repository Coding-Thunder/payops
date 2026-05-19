import { MarketingSection, AccentWord } from "../section";
import { ScreenshotFrame } from "../mocks/screenshot-frame";

const RECEIPTS = [
  { label: "Order audit chain", sub: "append-only, typed" },
  { label: "Payment intent + charge id", sub: "gateway round-trip" },
  { label: "Email correspondence", sub: "rendered HTML + text" },
  { label: "Hosted consent signature", sub: "name + IP + UA" },
  { label: "Hashed event timestamps", sub: "SHA-256 chained" },
  { label: "Gateway webhook receipts", sub: "verified signatures" },
  { label: "Lifecycle state transitions", sub: "1..N sequence" },
  { label: "PDF evidence export", sub: "one-click forward" },
];

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
      description="Banks want proof you delivered, the customer agreed, and the charge matches the order. PayOps captures every artefact inline — contesting a chargeback is a click, not a forensic exercise."
    >
      {/* Sticky-pin split: product visual sticks while receipts scroll. */}
      <div className="grid gap-14 lg:grid-cols-[1.05fr_1fr] lg:items-start">
        <div
          data-reveal
          data-reveal-order={0}
          className="lg:sticky lg:top-32"
        >
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-10 -z-10 rounded-[2rem] opacity-60 blur-3xl"
              style={{
                background:
                  "radial-gradient(ellipse 70% 70% at 50% 50%, color-mix(in oklch, var(--m-orange) 50%, transparent) 0%, transparent 70%)",
              }}
            />
            <ScreenshotFrame
              src="/marketing/evidence-chain.webp"
              alt="PayOps evidence chain for a disputed order"
              bare
              className="ring-1 ring-[color:var(--m-border)]"
            />
          </div>

          <div
            data-reveal
            data-reveal-order={1}
            className="mt-6 rounded-2xl border p-5 backdrop-blur"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface-strong)",
            }}
          >
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              Webhook → evidence pack
            </p>
            <p className="mt-2 text-[13px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              <span className="font-mono text-[12.5px] text-current">
                charge.dispute.created
              </span>{" "}
              → order auto-flagged → evidence chain frozen → operator
              notified → PDF ready to forward to the bank.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px]">
              {[
                { v: "<60s", k: "freeze" },
                { v: "100%", k: "captured" },
                { v: "1 click", k: "export" },
              ].map((s) => (
                <div
                  key={s.k}
                  className="rounded-lg border px-2 py-2"
                  style={{ borderColor: "var(--m-border)" }}
                >
                  <p className="font-mono text-[14px] font-semibold">
                    {s.v}
                  </p>
                  <p
                    className="mt-0.5 font-mono uppercase tracking-[0.12em]"
                    style={{ color: "var(--m-fg-soft)" }}
                  >
                    {s.k}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>
          <p
            data-reveal
            data-reveal-order={1}
            className="text-[15.5px] leading-relaxed"
          >
            Every order persists a compliance-grade record. The moment a
            dispute webhook fires, PayOps freezes the chain, auto-flags
            risk, and prepares an exportable packet — long before the
            bank's evidence deadline.
          </p>

          <ul className="mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {RECEIPTS.map((r, i) => (
              <li
                key={r.label}
                data-reveal
                data-reveal-order={2 + (i % 4)}
                className="group flex items-start gap-3 rounded-xl border p-3.5 transition-colors"
                style={{
                  borderColor: "var(--m-border)",
                  background: "var(--m-surface)",
                }}
              >
                <CheckBadge />
                <div>
                  <p className="text-[13.5px] font-medium">{r.label}</p>
                  <p
                    className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em]"
                    style={{ color: "var(--m-fg-soft)" }}
                  >
                    {r.sub}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </MarketingSection>
  );
}

function CheckBadge() {
  return (
    <span
      aria-hidden
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full"
      style={{
        background:
          "linear-gradient(135deg, var(--m-orange) 0%, var(--m-orange-deep) 100%)",
        color: "white",
      }}
    >
      <svg viewBox="0 0 12 12" className="size-3" fill="none">
        <path
          d="M2.5 6.5L4.8 8.6L9.5 3.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
