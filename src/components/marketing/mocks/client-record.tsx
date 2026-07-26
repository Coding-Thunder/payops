import {
  CheckCircle2Icon,
  ClockIcon,
  CreditCardIcon,
  FileSignatureIcon,
  FileTextIcon,
  MailIcon,
  PackageCheckIcon,
  PaperclipIcon,
  PenLineIcon,
  ReceiptIcon,
  SearchIcon,
  ShieldCheckIcon,
  UploadIcon,
  UserPlusIcon,
} from "lucide-react";

/**
 * Static, presentational mocks for the Features page. They speak the same
 * light "TraceTxn dashboard" language as the app (white cards, hairline
 * borders, one emerald accent) so the marketing page shows real product
 * shapes, not abstract illustrations. No interactivity — server-rendered.
 *
 * Everything centers on one example client: Vela Skincare.
 */

const EMERALD = "var(--brand-emerald)";
const EMERALD_STRONG = "var(--brand-emerald-strong)";
const EMERALD_TINT = "color-mix(in oklch, var(--brand-emerald) 12%, white)";

/** App-window chrome: three muted dots + a mono path label. */
function MockFrame({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-border" />
          <span className="size-2 rounded-full bg-border" />
          <span className="size-2 rounded-full bg-border" />
        </div>
        <span className="truncate font-mono text-[10.5px] tracking-tight text-muted-foreground">
          {path}
        </span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg font-display text-[12px] font-semibold"
      style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
    >
      {initials}
    </span>
  );
}

function PaidChip() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
    >
      <CheckCircle2Icon className="size-3" />
      Paid
    </span>
  );
}

function ClientHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <Avatar initials="VS" />
        <div>
          <div className="font-display text-[14px] font-semibold tracking-tight">
            Vela Skincare
          </div>
          <div className="text-[12px] text-muted-foreground">
            hello@velaskincare.com
          </div>
        </div>
      </div>
      <span
        className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-2.5 py-0.5 text-[10.5px] text-muted-foreground"
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ background: EMERALD }}
        />
        Client since Jan 2026
      </span>
    </div>
  );
}

const RECORD_TABS = ["Timeline", "Invoices", "Payments", "Consent", "Files"];

/** Hero + Feature 01 centerpiece: a full client record with tabs. */
export function ClientRecordPreview() {
  return (
    <MockFrame path="app.tracetxn.com / clients / vela-skincare">
      <ClientHeader />

      {/* quick facts */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[
          { k: "Lifetime", v: "$13,000" },
          { k: "Invoices", v: "2" },
          { k: "Last activity", v: "Mar 6" },
        ].map((f) => (
          <div
            key={f.k}
            className="rounded-lg border border-border bg-[color:var(--background)] px-3 py-2"
          >
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {f.k}
            </div>
            <div className="mt-0.5 font-display text-[14px] font-semibold tracking-tight">
              {f.v}
            </div>
          </div>
        ))}
      </div>

      {/* tab strip */}
      <div className="mt-4 flex flex-wrap gap-1 border-b border-border">
        {RECORD_TABS.map((t, i) => (
          <span
            key={t}
            className={
              i === 0
                ? "relative -mb-px border-b-2 px-3 py-2 text-[12px] font-medium text-foreground"
                : "px-3 py-2 text-[12px] text-muted-foreground"
            }
            style={i === 0 ? { borderColor: EMERALD } : undefined}
          >
            {t}
          </span>
        ))}
      </div>

      {/* active tab body: a slice of the timeline */}
      <div className="mt-4 space-y-2.5">
        {[
          { Icon: ReceiptIcon, t: "Invoice INV-1061 sent", d: "Mar 5" },
          { Icon: CreditCardIcon, t: "Payment received · $6,500", d: "Mar 5" },
          { Icon: PackageCheckIcon, t: "Project delivered", d: "Mar 6" },
        ].map((e) => (
          <div key={e.t} className="flex items-center gap-3">
            <span
              className="inline-flex size-7 items-center justify-center rounded-md"
              style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
            >
              <e.Icon className="size-3.5" />
            </span>
            <span className="flex-1 text-[12.5px] text-foreground/85">{e.t}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {e.d}
            </span>
          </div>
        ))}
      </div>
    </MockFrame>
  );
}

/** Feature 01 support: the connected sections of a client record. */
const CONNECTED = [
  { Icon: UserPlusIcon, label: "Client details" },
  { Icon: MailIcon, label: "Contact info" },
  { Icon: ReceiptIcon, label: "Invoices" },
  { Icon: CreditCardIcon, label: "Payments" },
  { Icon: ShieldCheckIcon, label: "Consent" },
  { Icon: PaperclipIcon, label: "Files" },
  { Icon: PenLineIcon, label: "Notes" },
  { Icon: FileSignatureIcon, label: "Agreements" },
  { Icon: ClockIcon, label: "Timeline" },
];

export function ConnectedSections() {
  return (
    <MockFrame path="clients / vela-skincare">
      <ClientHeader />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {CONNECTED.map((c) => (
          <div
            key={c.label}
            className="flex items-center gap-2 rounded-lg border border-border bg-[color:var(--background)] px-3 py-2.5"
          >
            <c.Icon className="size-3.5" style={{ color: EMERALD_STRONG }} />
            <span className="text-[12px] font-medium text-foreground/85">
              {c.label}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-muted-foreground">
        All connected to one record — nothing scattered across tools.
      </p>
    </MockFrame>
  );
}

/** Feature 02: chronological client timeline. */
const TIMELINE = [
  { Icon: UserPlusIcon, t: "Client created", d: "Jan 3, 2026" },
  { Icon: FileSignatureIcon, t: "Agreement added", d: "Jan 5, 2026" },
  { Icon: ReceiptIcon, t: "Invoice INV-1042 sent", d: "Jan 10, 2026" },
  { Icon: CreditCardIcon, t: "Payment received · $6,500", d: "Jan 14, 2026" },
  { Icon: ShieldCheckIcon, t: "Consent captured · scope change", d: "Feb 2, 2026" },
  { Icon: PenLineIcon, t: "Scope updated", d: "Feb 2, 2026" },
  { Icon: UploadIcon, t: "File uploaded · Brand-Guidelines.pdf", d: "Feb 10, 2026" },
  { Icon: PackageCheckIcon, t: "Project delivered", d: "Mar 6, 2026" },
];

export function TimelineCard() {
  return (
    <MockFrame path="clients / vela-skincare / timeline">
      <div className="relative pl-2">
        <div
          aria-hidden
          className="absolute bottom-2 left-[15px] top-2 w-px bg-border"
        />
        <ul className="space-y-3.5">
          {TIMELINE.map((e) => (
            <li key={e.t} className="relative flex items-center gap-3">
              <span
                className="relative z-10 inline-flex size-7 items-center justify-center rounded-full border border-border bg-white"
                style={{ color: EMERALD_STRONG }}
              >
                <e.Icon className="size-3.5" />
              </span>
              <span className="flex-1 text-[12.5px] text-foreground/85">
                {e.t}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {e.d}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </MockFrame>
  );
}

/** Feature 03: global search. */
export function SearchCard() {
  return (
    <MockFrame path="app.tracetxn.com">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-[color:var(--background)] px-3 py-2.5">
        <SearchIcon className="size-4 text-muted-foreground" />
        <span className="text-[14px] text-foreground">Vela</span>
        <span
          aria-hidden
          className="ml-0.5 inline-block h-4 w-px animate-pulse bg-foreground/60"
        />
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          ⌘K
        </span>
      </div>

      {/* result dropdown */}
      <div className="mt-2 overflow-hidden rounded-lg border border-border bg-white">
        <div
          className="flex items-center gap-3 border-l-2 px-3 py-2.5"
          style={{ borderColor: EMERALD, background: EMERALD_TINT }}
        >
          <Avatar initials="VS" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-tight">
              Vela Skincare
            </div>
            <div className="truncate text-[11.5px] text-muted-foreground">
              hello@velaskincare.com · +1 (415) 555-0132
            </div>
          </div>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            ↵ open
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {["name", "email", "phone", "invoice #"].map((c) => (
          <span
            key={c}
            className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground"
          >
            {c}
          </span>
        ))}
      </div>
    </MockFrame>
  );
}

/** Feature 04: consent on the record. */
export function ConsentCard() {
  return (
    <MockFrame path="clients / vela-skincare / consent">
      <div className="rounded-lg border border-border bg-[color:var(--background)] p-4">
        <div className="flex items-start gap-3">
          <span
            className="inline-flex size-7 items-center justify-center rounded-md"
            style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
          >
            <ShieldCheckIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-tight">
              Scope change · extra landing page
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Client confirmed the updated scope and price of $1,500.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2Icon
              className="size-3.5"
              style={{ color: EMERALD_STRONG }}
            />
            Confirmed by client
          </span>
          <span className="font-mono">Feb 2, 2026 · 3:42 PM</span>
        </div>
      </div>
      <p className="mt-2.5 text-[11.5px] text-muted-foreground">
        A clear record of what was agreed, and when.
      </p>
    </MockFrame>
  );
}

/** Feature 05: invoices & payments on the client record. */
const INVOICES = [
  { no: "INV-1042", amt: "$6,500", date: "Jan 14, 2026" },
  { no: "INV-1061", amt: "$6,500", date: "Mar 5, 2026" },
];

export function InvoicesPaymentsCard() {
  return (
    <MockFrame path="clients / vela-skincare / invoices">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Vela Skincare · Invoices
        </span>
        <span className="text-[11px] text-muted-foreground">$13,000 paid</span>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {INVOICES.map((inv) => (
          <li
            key={inv.no}
            className="flex items-center gap-3 bg-white px-3 py-3"
          >
            <span
              className="inline-flex size-7 items-center justify-center rounded-md"
              style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
            >
              <ReceiptIcon className="size-3.5" />
            </span>
            <span className="font-mono text-[12px] font-medium">{inv.no}</span>
            <span className="font-display text-[13px] font-semibold tracking-tight">
              {inv.amt}
            </span>
            <PaidChip />
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
              {inv.date}
            </span>
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}

/** Feature 06: files & documents on the client record. */
const FILES = [
  "Master-Service-Agreement.pdf",
  "Brand-Guidelines.pdf",
  "Final-Invoice.pdf",
  "Project-Brief.pdf",
];

export function FilesCard() {
  return (
    <MockFrame path="clients / vela-skincare / files">
      <ul className="space-y-2">
        {FILES.map((f) => (
          <li
            key={f}
            className="flex items-center gap-3 rounded-lg border border-border bg-[color:var(--background)] px-3 py-2.5"
          >
            <span
              className="inline-flex size-7 items-center justify-center rounded-md"
              style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
            >
              <FileTextIcon className="size-3.5" />
            </span>
            <span className="flex-1 truncate text-[12.5px] font-medium text-foreground/85">
              {f}
            </span>
            <PaperclipIcon className="size-3.5 text-muted-foreground" />
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}

/** Feature 07: dated notes. */
const NOTES = [
  { t: "Prefers Slack for quick approvals.", d: "Jan 8, 2026" },
  { t: "Send invoices on the 1st of the month.", d: "Feb 1, 2026" },
  { t: "Approved the extra landing page over a call.", d: "Feb 2, 2026" },
];

export function NotesCard() {
  return (
    <MockFrame path="clients / vela-skincare / notes">
      <ul className="space-y-2.5">
        {NOTES.map((n) => (
          <li
            key={n.t}
            className="rounded-lg border border-border bg-[color:var(--background)] p-3"
          >
            <div className="flex items-start gap-2.5">
              <PenLineIcon
                className="mt-[3px] size-3.5 shrink-0"
                style={{ color: EMERALD_STRONG }}
              />
              <div className="min-w-0">
                <p className="text-[12.5px] leading-relaxed text-foreground/85">
                  {n.t}
                </p>
                <span className="mt-1 block font-mono text-[10.5px] text-muted-foreground">
                  {n.d}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </MockFrame>
  );
}

/** Feature 08: the without / with comparison. */
const SCATTERED = [
  "Gmail",
  "Slack",
  "WhatsApp",
  "Drive",
  "Payment dashboard",
  "Project tool",
];
const CONNECTED_FLOW = [
  "Timeline",
  "Invoices",
  "Payments",
  "Consent",
  "Files",
];

export function BeforeAfter() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Without */}
      <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
          <span className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Without TraceTxn
          </span>
        </div>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Search each tool separately and hope you find it.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {SCATTERED.map((s) => (
            <div
              key={s}
              className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-[color:var(--background)] px-3 py-2.5"
            >
              <SearchIcon className="size-3.5 text-muted-foreground/70" />
              <span className="text-[12px] text-muted-foreground">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* With */}
      <div
        className="rounded-2xl border p-5 shadow-sm"
        style={{
          borderColor: "color-mix(in oklch, var(--brand-emerald) 35%, white)",
          background: "color-mix(in oklch, var(--brand-emerald) 5%, white)",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full" style={{ background: EMERALD }} />
          <span
            className="font-display text-[11px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: EMERALD_STRONG }}
          >
            With TraceTxn
          </span>
        </div>
        <p className="mt-2 text-[13px] text-foreground/80">
          Search the client, open the record, see everything.
        </p>

        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2.5">
            <SearchIcon className="size-3.5" style={{ color: EMERALD_STRONG }} />
            <span className="text-[12.5px] font-medium">Vela</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              → Vela Skincare
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-white px-3 py-3">
            {CONNECTED_FLOW.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: EMERALD_TINT, color: EMERALD_STRONG }}
              >
                <CheckCircle2Icon className="size-3" />
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
