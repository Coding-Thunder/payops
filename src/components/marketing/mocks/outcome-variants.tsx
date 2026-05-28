import { CheckIcon, AlertCircleIcon, ClockIcon, XIcon } from "lucide-react";

/**
 * Marketing canvas — the polymorphic outcome panel, all four
 * variants displayed side-by-side at small scale.
 *
 * Demonstrates that every order in TraceTxn carries a
 * dispute-readiness profile, and that the same shell renders four
 * variants depending on lifecycle state. The references make the
 * "case won" outcome highly visible; this strip shows visitors that
 * READY is the everyday state, with OPEN / WON / LOST as the
 * dispute-active variants.
 *
 * Layered semantic palette: green (READY/WON), amber (OPEN), rose
 * (LOST) — the full reference tone-set in one compact composition.
 */

interface Variant {
  key: "READY" | "OPEN" | "WON" | "LOST";
  label: string;
  tag: string;
  amount?: string;
  amountLabel?: string;
  details: Array<[string, string]>;
  tone: {
    bg: string;
    border: string;
    label: string;
    icon: React.ReactNode;
  };
}

const VARIANTS: Variant[] = [
  {
    key: "READY",
    label: "READY",
    tag: "Dispute-ready",
    details: [
      ["Evidence", "9 events"],
      ["Consent", "Signed 08:21:22"],
      ["Integrity", "Valid"],
    ],
    tone: {
      bg: "oklch(0.94 0.08 148 / 0.6)",
      border: "oklch(0.62 0.17 148 / 0.35)",
      label: "var(--success-strong)",
      icon: <CheckIcon className="size-3.5" />,
    },
  },
  {
    key: "OPEN",
    label: "OPEN",
    tag: "Awaiting outcome",
    amount: "$2,840",
    amountLabel: "In dispute",
    details: [
      ["Reason", "13.1"],
      ["Opened", "2026-05-05"],
      ["Deadline", "2026-05-12"],
    ],
    tone: {
      bg: "oklch(0.96 0.06 78 / 0.7)",
      border: "oklch(0.78 0.13 78 / 0.4)",
      label: "oklch(0.45 0.16 78)",
      icon: <ClockIcon className="size-3.5" />,
    },
  },
  {
    key: "WON",
    label: "CASE WON",
    tag: "Reversed in your favor",
    amount: "$2,840",
    amountLabel: "Recovered",
    details: [
      ["Reason", "13.1"],
      ["Decided", "2026-05-21"],
      ["Outcome", "Won — Reversed"],
    ],
    tone: {
      bg: "oklch(0.62 0.17 148)",
      border: "oklch(0.52 0.18 148)",
      label: "white",
      icon: <CheckIcon className="size-3.5" />,
    },
  },
  {
    key: "LOST",
    label: "CASE LOST",
    tag: "Decided against",
    amount: "$2,840",
    amountLabel: "Lost",
    details: [
      ["Reason", "10.4"],
      ["Decided", "2026-05-18"],
      ["Outcome", "Lost"],
    ],
    tone: {
      bg: "oklch(0.97 0.04 22 / 0.7)",
      border: "oklch(0.78 0.13 22 / 0.4)",
      label: "oklch(0.5 0.18 22)",
      icon: <XIcon className="size-3.5" />,
    },
  },
];

export function OutcomeVariantsStrip() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {VARIANTS.map((v) => (
        <Variant key={v.key} variant={v} />
      ))}
    </div>
  );
}

function Variant({ variant }: { variant: Variant }) {
  const isWon = variant.key === "WON";
  return (
    <div
      className="overflow-hidden rounded-xl border bg-card"
      style={{
        borderColor: variant.tone.border,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          background: variant.tone.bg,
          color: variant.tone.label,
          borderBottom: `1px solid ${variant.tone.border}`,
        }}
      >
        <span aria-hidden>{variant.tone.icon}</span>
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em]">
          {variant.label}
        </span>
      </div>
      <div className="px-3 py-3">
        <p className="text-[11.5px] text-muted-foreground">{variant.tag}</p>
        {variant.amount ? (
          <div className="mt-3">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
              {variant.amountLabel}
            </p>
            <p
              className={`mt-0.5 font-mono text-[18px] font-semibold tabular-nums ${
                isWon ? "text-success" : ""
              }`}
            >
              {variant.amount}
            </p>
          </div>
        ) : null}
        <dl className="mt-3 space-y-1 border-t border-border/60 pt-2">
          {variant.details.map(([k, v]) => (
            <div
              key={k}
              className="grid grid-cols-[5rem_1fr] gap-2 text-[11px]"
            >
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
