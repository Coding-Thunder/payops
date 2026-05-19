import { MarketingSection, AccentWord } from "../section";

interface Gateway {
  key: string;
  label: string;
  status: "live" | "next" | "roadmap";
  note: string;
  glyph: string;
}

const GATEWAYS: Gateway[] = [
  {
    key: "stripe",
    label: "Stripe",
    status: "live",
    note: "Checkout + webhook + dispute + refund in production.",
    glyph: "S",
  },
  {
    key: "razorpay",
    label: "Razorpay",
    status: "next",
    note: "Adapter scaffold ready · India-region routing.",
    glyph: "R",
  },
  {
    key: "authorize",
    label: "Authorize.net",
    status: "next",
    note: "Adapter scaffold ready · activation on credentials.",
    glyph: "A",
  },
  {
    key: "adyen",
    label: "Adyen",
    status: "roadmap",
    note: "Card-present + 3DS routing under design.",
    glyph: "Y",
  },
  {
    key: "paypal",
    label: "PayPal",
    status: "roadmap",
    note: "Marketplace flow under design.",
    glyph: "P",
  },
  {
    key: "manual",
    label: "Manual",
    status: "live",
    note: "Wire, ACH, or any out-of-band capture flow.",
    glyph: "M",
  },
];

const STATUS_TONE: Record<
  Gateway["status"],
  { label: string; color: string }
> = {
  live: { label: "Live", color: "var(--m-sage)" },
  next: { label: "Next", color: "var(--m-cobalt)" },
  roadmap: { label: "Roadmap", color: "var(--m-ultraviolet)" },
};

export function MultiGateway() {
  return (
    <MarketingSection
      id="gateways"
      theme="cobalt"
      eyebrow="Gateway-agnostic orchestration"
      title={
        <>
          One gateway in production.{" "}
          <AccentWord>The rest, one adapter away.</AccentWord>
        </>
      }
      description="Stripe handles every active charge today. The orchestration layer underneath was built gateway-agnostic from day one — adapters slot in without rewriting the order lifecycle, webhook contract, or audit chain."
    >
      {/* ── Bento: provider logos ───────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {GATEWAYS.map((g, i) => {
          const tone = STATUS_TONE[g.status];
          return (
            <div
              key={g.key}
              data-reveal
              data-reveal-order={i % 3}
              className="group relative overflow-hidden rounded-2xl border p-6 backdrop-blur-sm transition-transform hover:-translate-y-px"
              style={{
                borderColor: "var(--m-border)",
                background: "var(--m-surface)",
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full opacity-30 blur-2xl transition-opacity group-hover:opacity-60"
                style={{
                  background: `radial-gradient(circle, ${tone.color} 0%, transparent 70%)`,
                }}
              />
              <div className="flex items-center justify-between">
                <span
                  className="grid size-12 place-items-center rounded-xl font-mono text-[18px] font-semibold"
                  style={{
                    background: "var(--m-surface-strong)",
                    border: "1px solid var(--m-border)",
                  }}
                >
                  {g.glyph}
                </span>
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em]"
                  style={{
                    background: `color-mix(in oklch, ${tone.color} 20%, transparent)`,
                    color: tone.color,
                    border: `1px solid color-mix(in oklch, ${tone.color} 35%, transparent)`,
                  }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: tone.color }}
                  />
                  {tone.label}
                </span>
              </div>
              <p className="mt-5 text-[16.5px] font-semibold tracking-tight">
                {g.label}
              </p>
              <p
                className="mt-1.5 text-[12.5px] leading-relaxed"
                style={{ color: "var(--m-fg-soft)" }}
              >
                {g.note}
              </p>
            </div>
          );
        })}
      </div>

      {/* ── Code block — dark embedded callout. Lives inside a
            now-white section so the syntax colors keep their bright
            terminal look against a fixed dark surface. */}
      <div
        data-reveal
        data-reveal-order={3}
        className="relative mt-12 overflow-hidden rounded-2xl shadow-[0_30px_60px_-24px_rgba(0,0,0,0.35)]"
        style={{
          background: "var(--m-ink)",
          border: "1px solid color-mix(in oklch, var(--m-cobalt) 30%, transparent)",
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, var(--m-cobalt) 50%, transparent 100%)",
          }}
        />
        <div
          className="flex items-center justify-between border-b px-5 py-3 font-mono text-[10.5px] uppercase tracking-[0.18em]"
          style={{
            borderColor: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <span>src/server/payments/gateway.ts</span>
          <span style={{ color: "oklch(0.82 0.12 256)" }}>interface</span>
        </div>
        <pre className="overflow-x-auto px-5 py-6 font-mono text-[13px] leading-[1.65] text-white/85">
          <code className="block">
            <Line>
              <K>interface</K> <T>PaymentGateway</T> <P>{`{`}</P>
            </Line>
            <Line indent={1}>
              <C>{`// Stable identifier + admin label.`}</C>
            </Line>
            <Line indent={1}>
              <N>key</N>: <T>PaymentGatewayKey</T>;
            </Line>
            <Line indent={1}>
              <N>label</N>: <T>string</T>;
            </Line>
            <Line indent={1}>
              <N>enabled</N>: <T>boolean</T>;
            </Line>
            <Line>{" "}</Line>
            <Line indent={1}>
              <C>{`// One contract, every adapter.`}</C>
            </Line>
            <Line indent={1}>
              <F>createSession</F>(input): <T>Promise</T>
              {`<CreatedSession>`};
            </Line>
            <Line indent={1}>
              <F>verifyWebhook</F>(body, sig): <T>VerifiedPaymentEvent</T>;
            </Line>
            <Line indent={1}>
              <F>getSessionStatus</F>(id): <T>Promise</T>
              {`<SessionStatus>`};
            </Line>
            <Line indent={1}>
              <F>expireSession</F>(id): <T>Promise</T>
              {`<void>`};
            </Line>
            <Line>
              <P>{`}`}</P>
            </Line>
          </code>
        </pre>
      </div>

      <p
        data-reveal
        data-reveal-order={5}
        className="mt-6 text-[12.5px]"
        style={{ color: "var(--m-fg-soft)" }}
      >
        Routing precedence: per-order override → org default → registry
        default. Normalised{" "}
        <span className="font-mono text-current">VerifiedPaymentEvent</span>{" "}
        shape across providers.
      </p>
    </MarketingSection>
  );
}

// ─── Tiny syntax-color helpers ───────────────────────────────────
function Line({
  children,
  indent = 0,
}: {
  children: React.ReactNode;
  indent?: number;
}) {
  return (
    <span className="block whitespace-pre">
      {"  ".repeat(indent)}
      {children}
    </span>
  );
}
function K({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "oklch(0.82 0.18 302)" }}>{children}</span>;
}
function T({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "oklch(0.84 0.15 196)" }}>{children}</span>;
}
function N({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "oklch(0.94 0.04 60)" }}>{children}</span>;
}
function F({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "oklch(0.88 0.15 86)" }}>{children}</span>;
}
function P({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: "oklch(0.82 0.05 286)" }}>{children}</span>
  );
}
function C({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: "oklch(0.6 0.04 160)", fontStyle: "italic" }}>
      {children}
    </span>
  );
}
