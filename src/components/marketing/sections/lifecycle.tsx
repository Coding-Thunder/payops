import { MarketingSection, AccentWord } from "../section";

const STAGES: Array<{ label: string; description: string }> = [
  {
    label: "Created",
    description: "Order is drafted. No gateway side-effects yet.",
  },
  {
    label: "Draft saved",
    description: "Manual save. No silent autosave to surprise you.",
  },
  {
    label: "Gateway selected",
    description: "Operator picks the gateway. Frozen onto the order from here.",
  },
  {
    label: "Payment link generated",
    description: "Gateway session created. URL persisted, expiry stamped.",
  },
  {
    label: "Email sent",
    description: "Request email dispatched. Consent record created in lockstep.",
  },
  {
    label: "Consent received",
    description: "Customer signs on the hosted page. IP + UA captured.",
  },
  {
    label: "Payment started",
    description: "Customer reaches the gateway checkout.",
  },
  {
    label: "Paid",
    description: "Webhook reconciles. Audit + event + outbox fire atomically.",
  },
  {
    label: "Confirmation sent",
    description: "Receipt delivered via durable outbox. Timeline goes green.",
  },
  {
    label: "Refunded / Failed",
    description: "Refund and failure paths preserve the full chain.",
  },
];

const SURFACES: Array<{ label: string; meta: string }> = [
  { label: "Payment requests", meta: "draft → send" },
  { label: "Confirmations", meta: "receipt + retry" },
  { label: "Gateway activity", meta: "webhook + reconcile" },
  { label: "Customer consent", meta: "hosted + signed" },
  { label: "Payment state", meta: "canonical lifecycle" },
  { label: "Disputes", meta: "auto-flag + freeze" },
  { label: "Evidence chain", meta: "hashed + exportable" },
  { label: "Audit trails", meta: "append-only" },
  { label: "Exports", meta: "CSV + PDF" },
  { label: "Order notes", meta: "operator scratch" },
  { label: "Email templates", meta: "versioned + active" },
  { label: "Internal comms", meta: "team activity feed" },
];

export function Lifecycle() {
  return (
    <MarketingSection
      id="lifecycle"
      theme="sage"
      eyebrow="The lifecycle is the model"
      title={
        <>
          Every state of every order, captured in{" "}
          <AccentWord>one canonical chain.</AccentWord>
        </>
      }
      description="Operators stop asking 'is this paid yet'. The lifecycle is the answer — visible in realtime, derived from backend authority, with no UI shortcuts or optimistic guesses."
    >
      {/* React-rendered timeline (no screenshot) */}
      <div className="grid gap-16 lg:grid-cols-[1fr_1.05fr] lg:items-start">
        <div
          data-reveal
          data-reveal-order={0}
          className="relative lg:sticky lg:top-32"
        >
          {/* Vertical track */}
          <div
            aria-hidden
            className="absolute left-[18px] top-3 bottom-3 w-px"
            style={{
              background:
                "linear-gradient(to bottom, transparent 0%, var(--m-sage-deep) 8%, var(--m-sage-deep) 92%, transparent 100%)",
            }}
          />
          <ol className="space-y-5">
            {STAGES.map((s, i) => (
              <li
                key={s.label}
                data-reveal
                data-reveal-order={i % 5}
                className="relative grid grid-cols-[40px_1fr] items-start gap-4"
              >
                <span
                  className="relative z-10 grid size-9 place-items-center rounded-full text-[11px] font-mono"
                  style={{
                    background: "var(--m-surface-strong)",
                    border: "1px solid var(--m-border)",
                    color: "var(--m-eyebrow)",
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                  {i === STAGES.length - 1 ? null : (
                    <span
                      data-pulse
                      className="absolute -bottom-1 left-1/2 size-2 -translate-x-1/2 rounded-full"
                      style={{
                        background: "var(--m-sage-deep)",
                        animation: "pulse-soft 2.6s ease-in-out infinite",
                        animationDelay: `${i * 0.18}s`,
                      }}
                    />
                  )}
                </span>
                <div className="pt-1.5">
                  <p className="text-[14.5px] font-medium">{s.label}</p>
                  <p
                    className="mt-1 text-[12.5px] leading-relaxed"
                    style={{ color: "var(--m-fg-soft)" }}
                  >
                    {s.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Right column: 12-surface bento grid */}
        <div>
          <div className="mb-7 max-w-md">
            <p
              className="font-mono text-[10.5px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              One operational hub
            </p>
            <h3 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight">
              Twelve surfaces, zero duplicate truth.
            </h3>
            <p
              className="mt-3 text-[13.5px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              The dashboard, order detail, email composer, and dispute
              log all read the same record at the same time. No shadow
              Postgres. No stale cache.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {SURFACES.map((s, i) => (
              <div
                key={s.label}
                data-reveal
                data-reveal-order={i % 4}
                className="rounded-xl border p-3.5 transition-transform hover:-translate-y-px"
                style={{
                  borderColor: "var(--m-border)",
                  background: "var(--m-surface)",
                }}
              >
                <p className="text-[13px] font-medium leading-tight">
                  {s.label}
                </p>
                <p
                  className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                  style={{ color: "var(--m-fg-soft)" }}
                >
                  {s.meta}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </MarketingSection>
  );
}
