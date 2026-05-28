/**
 * Gateways region — the dark code block as the centerpiece, with
 * compact prose flowing around it and a quiet status table below.
 *
 * Different rhythm from the regions above: tight composition, dark
 * mid-document inset, no canvas embed.
 */

const GATEWAYS: Array<{
  key: string;
  label: string;
  status: "live" | "next" | "roadmap";
  note: string;
}> = [
  {
    key: "stripe",
    label: "Stripe",
    status: "live",
    note: "Checkout · webhooks · disputes · refunds in production",
  },
  {
    key: "razorpay",
    label: "Razorpay",
    status: "next",
    note: "Adapter scaffold ready · India-region routing",
  },
  {
    key: "authorize",
    label: "Authorize.net",
    status: "next",
    note: "Adapter scaffold ready · activation on credentials",
  },
  {
    key: "adyen",
    label: "Adyen",
    status: "roadmap",
    note: "Card-present + 3DS routing under design",
  },
  {
    key: "paypal",
    label: "PayPal",
    status: "roadmap",
    note: "Marketplace flow under design",
  },
  {
    key: "manual",
    label: "Manual",
    status: "live",
    note: "Wire · ACH · any out-of-band capture flow",
  },
];

export function GatewaysRegion() {
  return (
    <section id="gateways" className="scroll-mt-20 pt-20 sm:pt-28">
      <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-start">
        <div>
          <p className="text-[15.5px] leading-relaxed text-foreground">
            One gateway in production today. Four more, one adapter away
            each.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
            The orchestration layer under TraceTxn was built
            gateway-agnostic from day one. New adapters slot in without
            rewriting the order lifecycle, the webhook contract, or the
            audit chain — they implement one interface and the rest of
            the platform doesn&apos;t know which provider routed a
            specific charge.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Routing precedence: per-order override → org default →
            registry default. Normalised{" "}
            <code className="font-mono text-[12.5px]">
              VerifiedPaymentEvent
            </code>{" "}
            shape across providers.
          </p>
        </div>

        <div
          className="overflow-hidden rounded-xl shadow-[0_24px_60px_-32px_rgba(0,0,0,0.35)]"
          style={{ background: "oklch(0.13 0.012 286)" }}
        >
          <div
            className="flex items-center justify-between border-b border-white/10 px-5 py-3 font-mono text-[10.5px] uppercase tracking-[0.16em]"
            style={{ color: "rgba(255,255,255,0.55)" }}
          >
            <span>src/server/payments/gateway.ts</span>
            <span style={{ color: "oklch(0.82 0.12 256)" }}>interface</span>
          </div>
          <pre className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.6] text-white/85">
            <code className="block">
              <Ln>
                <K>interface</K> <T>PaymentGateway</T> <P>{`{`}</P>
              </Ln>
              <Ln indent={1}>
                <C>{`// Stable identifier + admin label.`}</C>
              </Ln>
              <Ln indent={1}>
                <N>key</N>: <T>PaymentGatewayKey</T>;
              </Ln>
              <Ln indent={1}>
                <N>label</N>: <T>string</T>;
              </Ln>
              <Ln indent={1}>
                <N>enabled</N>: <T>boolean</T>;
              </Ln>
              <Ln>{" "}</Ln>
              <Ln indent={1}>
                <C>{`// One contract, every adapter.`}</C>
              </Ln>
              <Ln indent={1}>
                <F>createSession</F>(input): <T>Promise</T>
                {`<CreatedSession>`};
              </Ln>
              <Ln indent={1}>
                <F>verifyWebhook</F>(body, sig): <T>VerifiedPaymentEvent</T>;
              </Ln>
              <Ln indent={1}>
                <F>getSessionStatus</F>(id): <T>Promise</T>
                {`<SessionStatus>`};
              </Ln>
              <Ln indent={1}>
                <F>expireSession</F>(id): <T>Promise</T>
                {`<void>`};
              </Ln>
              <Ln>
                <P>{`}`}</P>
              </Ln>
            </code>
          </pre>
        </div>
      </div>

      {/* Compact status table — no per-card chrome */}
      <div className="mt-10 border-y border-border">
        {(["live", "next", "roadmap"] as const).map((status) => {
          const rows = GATEWAYS.filter((g) => g.status === status);
          if (rows.length === 0) return null;
          const tone =
            status === "live"
              ? "text-success"
              : status === "next"
                ? "text-foreground"
                : "text-muted-foreground";
          return (
            <div
              key={status}
              className="grid grid-cols-[6rem_1fr] items-baseline gap-x-6 border-b border-border last:border-b-0 py-4"
            >
              <p
                className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] ${tone}`}
              >
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${
                    status === "live"
                      ? "bg-success"
                      : status === "next"
                        ? "bg-foreground"
                        : "bg-muted-foreground"
                  }`}
                />
                {status === "live"
                  ? "Live"
                  : status === "next"
                    ? "Next"
                    : "Roadmap"}
              </p>
              <ul className="space-y-1.5">
                {rows.map((g) => (
                  <li
                    key={g.key}
                    className="grid grid-cols-[8rem_1fr] items-baseline gap-x-4"
                  >
                    <span className="text-[13.5px] font-medium">
                      {g.label}
                    </span>
                    <span className="text-[12.5px] text-muted-foreground">
                      {g.note}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ─── tiny syntax helpers ─────────────────────────────────────────── */
function Ln({
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
  return <span style={{ color: "oklch(0.82 0.05 286)" }}>{children}</span>;
}
function C({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: "oklch(0.6 0.04 160)", fontStyle: "italic" }}>
      {children}
    </span>
  );
}
