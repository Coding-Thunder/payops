import {
  LiveDot,
  Panel,
  ProductFrame,
  Reveal,
  Section,
  StatCard,
  StatusBadge,
  Td,
  Th,
} from "@/components/marketing/home/primitives";

/**
 * The product walkthrough: six capabilities, each shown before it is
 * explained.
 *
 * ── The rule this file follows ───────────────────────────────────────────
 *
 * Screen first, sentence second. Every block is a real screen on one side and
 * at most four lines of prose on the other — never a paragraph with a
 * decorative image bolted on. If a capability cannot be shown, it does not
 * get a block.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 *
 * No block for approvals, e-signature, time tracking, proposals or
 * forecasting: none of them exist, and `seo-claims.test.ts` fails the build
 * if the marketing surfaces start implying otherwise. The six below are all
 * reachable by a signed-in user today, and each screen is modelled on the
 * real one — the analytics block in particular reproduces the actual stat
 * cards, the real "Sum of confirmed payments per calendar day" caption, and
 * the item-type / top-staff breakdowns rather than inventing a prettier
 * chart.
 *
 * All figures are illustrative and labelled as such. They are not a
 * customer's data and not presented as outcomes.
 */

/* ─── Block shell ──────────────────────────────────────────────────────── */

function Block({
  id,
  eyebrow,
  title,
  copy,
  points,
  media,
  flip = false,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  copy: string;
  points: string[];
  media: React.ReactNode;
  /** Put the screen on the left instead of the right. */
  flip?: boolean;
}) {
  return (
    <div
      id={id}
      className="grid items-center gap-8 py-14 lg:grid-cols-2 lg:gap-14 lg:py-20"
    >
      <Reveal className={flip ? "min-w-0 lg:order-2" : "min-w-0"}>
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
          {eyebrow}
        </span>
        <h3
          className="mt-3 font-display text-[24px] font-semibold leading-[1.18] tracking-[-0.02em] text-[#0A1128] sm:text-[28px]"
          style={{ textWrap: "balance" }}
        >
          {title}
        </h3>
        <p className="mt-4 max-w-[52ch] text-[15px] leading-[1.65] text-[#4A5568]">
          {copy}
        </p>
        <ul className="mt-6 grid gap-2.5">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--brand-blue)]"
              />
              <span className="text-[13.5px] leading-snug text-[#0F172A]">
                {p}
              </span>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={0.06} className={flip ? "min-w-0 lg:order-1" : "min-w-0"}>
        {media}
      </Reveal>
    </div>
  );
}

/* ─── A · Client timeline ──────────────────────────────────────────────── */

const TIMELINE = [
  ["Today 09:14", "Payment confirmed · INV-0114", "paid", "PAID"],
  ["Mar 3 16:02", "Invoice INV-0114 emailed to ops@", "info", "SENT"],
  ["Mar 1 11:40", "Stage 2 → In production", "pending", "WIP"],
  ["Feb 28 10:05", "brand-pack-v3.zip uploaded", "info", "FILE"],
  ["Feb 24 14:22", "Note: wants the deck before Friday", "info", "NOTE"],
  ["Feb 12 09:00", "Scope v3 signed, attached to client", "paid", "AGREED"],
  ["Jan 30 17:31", "Invoice INV-0098 expired, re-issued", "expired", "EXPIRED"],
] as const;

function TimelineMedia() {
  return (
    <ProductFrame label="/app/customers/northwind-studio#timeline" live>
      <Panel title="Timeline" caption="Everything that happened, newest first">
        <ul className="divide-y divide-[#F1F5F9]">
          {TIMELINE.map(([when, what, tone, badge]) => (
            <li key={what} className="flex items-start gap-3 px-4 py-2.5">
              <span className="mt-[2px] w-[78px] shrink-0 font-mono text-[10px] tabular-nums text-[#64748B]">
                {when}
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-[#0F172A]">
                {what}
              </span>
              <StatusBadge
                tone={tone as "paid" | "pending" | "info" | "expired"}
                className="shrink-0"
              >
                {badge}
              </StatusBadge>
            </li>
          ))}
        </ul>
      </Panel>
    </ProductFrame>
  );
}

/* ─── B · Client profile ───────────────────────────────────────────────── */

function ProfileMedia() {
  return (
    <ProductFrame label="/app/customers?q=northwind">
      <div className="border-b border-[#E9EFF6] px-4 py-3">
        <div className="flex items-center gap-2 rounded border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1.5">
          <span aria-hidden className="text-[11px] text-[#64748B]">
            ⌕
          </span>
          <span className="font-mono text-[11.5px] text-[#0F172A]">
            northwind
          </span>
          <span className="ml-auto font-mono text-[10px] text-[#64748B]">
            1 match
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Client</Th>
              <Th>Orders</Th>
              <Th>Outstanding</Th>
              <Th>Last activity</Th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-[var(--brand-blue-soft)]/60">
              <Td strong>Northwind Studio</Td>
              <Td mono>7</Td>
              <Td mono strong>
                £1,800
              </Td>
              <Td mono>Today</Td>
            </tr>
            <tr>
              <Td strong>Harbour &amp; Co</Td>
              <Td mono>3</Td>
              <Td mono>£0</Td>
              <Td mono>Mar 2</Td>
            </tr>
            <tr>
              <Td strong>Lumen Labs</Td>
              <Td mono>12</Td>
              <Td mono strong>
                £6,250
              </Td>
              <Td mono>Feb 27</Td>
            </tr>
          </tbody>
        </table>
      </div>
      <Panel
        title="Northwind Studio"
        caption="One record · everything attached"
        className="border-t"
      >
        <div className="grid grid-cols-2 gap-px bg-[#F1F5F9] sm:grid-cols-3">
          {[
            ["Orders", "7"],
            ["Invoices", "9"],
            ["Payments", "£10,600"],
            ["Files", "14"],
            ["Links", "3"],
            ["Notes", "22"],
          ].map(([k, v]) => (
            <div key={k} className="bg-white px-3.5 py-2.5">
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                {k}
              </div>
              <div className="mt-0.5 font-display text-[15px] font-semibold tabular-nums text-[#0A1128]">
                {v}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </ProductFrame>
  );
}

/* ─── C · Orders + fulfilment ──────────────────────────────────────────── */

const FLOW = [
  ["Order created", "done"],
  ["Payment link sent", "done"],
  ["Payment confirmed", "done"],
  ["In production", "now"],
  ["Files delivered", "next"],
  ["Completed", "next"],
] as const;

function OrdersMedia() {
  return (
    <ProductFrame label="/app/orders/1042">
      <div className="flex items-start justify-between gap-3 border-b border-[#E9EFF6] px-4 py-3">
        <div>
          <div className="font-mono text-[12px] font-semibold text-[#0F172A]">
            #1042
          </div>
          <div className="mt-0.5 text-[11.5px] text-[#64748B]">
            Brand system · stage 2 · Northwind Studio
          </div>
        </div>
        <div className="text-right">
          <div className="font-display text-[17px] font-semibold tabular-nums text-[#0A1128]">
            £4,000
          </div>
          <StatusBadge tone="paid" className="mt-1">
            paid
          </StatusBadge>
        </div>
      </div>

      <Panel title="Fulfilment" caption="Stages you define, not ours">
        <ol className="divide-y divide-[#F1F5F9]">
          {FLOW.map(([label, state]) => (
            <li key={label} className="flex items-center gap-3 px-4 py-2.5">
              <span
                aria-hidden
                className={
                  state === "done"
                    ? "flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--brand-emerald-soft)] text-[9px] text-[#047857]"
                    : state === "now"
                      ? "flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--brand-blue-border)] bg-[var(--brand-blue-soft)]"
                      : "flex size-4 shrink-0 items-center justify-center rounded-full border border-[#E2E8F0]"
                }
              >
                {state === "done" ? "✓" : state === "now" ? <LiveDot /> : null}
              </span>
              <span
                className={
                  state === "next"
                    ? "flex-1 text-[12.5px] text-[#64748B]"
                    : "flex-1 text-[12.5px] text-[#0F172A]"
                }
              >
                {label}
              </span>
              {state === "now" ? (
                <StatusBadge tone="pending">current</StatusBadge>
              ) : null}
            </li>
          ))}
        </ol>
      </Panel>
      <div className="border-t border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2 text-[10.5px] text-[#64748B]">
        The transaction and the delivery are the same record.
      </div>
    </ProductFrame>
  );
}

/* ─── D · Client email, in context ─────────────────────────────────────── */

function EmailMedia() {
  return (
    <ProductFrame label="/app/orders/1051/email">
      <div className="grid sm:grid-cols-[150px_minmax(0,1fr)]">
        {/* Context rail — the whole point of composing here */}
        <div className="divide-y divide-[#F1F5F9] border-[#E9EFF6] sm:border-r">
          <div className="px-3.5 py-2.5">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              Client
            </div>
            <div className="mt-0.5 text-[12px] font-medium text-[#0F172A]">
              Northwind Studio
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              Order
            </div>
            <div className="mt-0.5 font-mono text-[12px] text-[#0F172A]">
              #1051
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              Amount
            </div>
            <div className="mt-0.5 font-display text-[14px] font-semibold tabular-nums text-[#0A1128]">
              £1,800
            </div>
          </div>
          <div className="px-3.5 py-2.5">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
              Status
            </div>
            <StatusBadge tone="pending" className="mt-1">
              pending
            </StatusBadge>
          </div>
        </div>

        {/* Composer */}
        <div>
          <div className="space-y-px bg-[#F1F5F9]">
            {[
              ["To", "ops@northwind.studio"],
              ["Template", "Payment request · deposit"],
              ["Subject", "Deposit for the website build — £1,800"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 bg-white px-3.5 py-2">
                <span className="w-[62px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">
                  {k}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#0F172A]">
                  {v}
                </span>
              </div>
            ))}
          </div>
          <div className="px-3.5 py-3 text-[12px] leading-relaxed text-[#4A5568]">
            Hi Priya — here&apos;s the deposit invoice for the website build.
            <br />
            <span className="rounded bg-[var(--brand-blue-soft)] px-1 font-mono text-[11px] text-[#0052D6]">
              {"{{payment_link}}"}
            </span>{" "}
            ·{" "}
            <span className="rounded bg-[var(--brand-blue-soft)] px-1 font-mono text-[11px] text-[#0052D6]">
              {"{{amount}}"}
            </span>{" "}
            fill from the order.
          </div>
          <div className="flex items-center gap-2 border-t border-[#E9EFF6] px-3.5 py-2.5">
            <span className="inline-flex h-7 items-center rounded bg-[#0F172A] px-2.5 text-[11.5px] font-semibold text-white">
              Send
            </span>
            <span className="text-[10.5px] text-[#64748B]">
              Recorded on the client&apos;s timeline
            </span>
          </div>
        </div>
      </div>
    </ProductFrame>
  );
}

/* ─── E · Analytics ───────────────────────────────────────────────────── */

const ITEM_TYPES = [
  ["Local SEO management", "8 orders", "£8,400", 100],
  ["Link building campaign", "5 orders", "£5,250", 62],
  ["Technical SEO audit", "4 orders", "£2,800", 33],
  ["SEO content campaign", "3 orders", "£2,000", 24],
] as const;

const TOP_STAFF = [
  ["Priya Raman", "15 orders", "£12,450"],
  ["Daniel Okafor", "6 orders", "£4,200"],
  ["Mason Brooks", "3 orders", "£1,800"],
] as const;

/** Deterministic spark path — no Math.random, so SSR and client agree. */
const SPARK = [8, 14, 11, 19, 16, 24, 21, 29, 26, 34, 31, 38, 44, 41]
  .map((v, i, a) => `${(i / (a.length - 1)) * 100},${40 - (v / 48) * 40}`)
  .join(" ");

function AnalyticsMedia() {
  return (
    <ProductFrame label="/app/admin/analytics" live>
      <div className="grid grid-cols-2 gap-px bg-[#F1F5F9] lg:grid-cols-4">
        <div className="bg-white">
          <StatCard label="Revenue" value="£18,450" caption="12 paid" delta="+24%" />
        </div>
        <div className="bg-white">
          <StatCard
            label="Average order"
            value="£1,538"
            caption="Across paid orders"
            delta="+12%"
          />
        </div>
        <div className="bg-white">
          <StatCard label="Conversion" value="68%" caption="25 total" delta="+8%" />
        </div>
        <div className="bg-white">
          <StatCard
            label="Outstanding"
            value="4"
            caption="2 failed/expired"
            tone="warning"
          />
        </div>
      </div>

      <Panel
        title="Daily revenue"
        caption="Sum of confirmed payments per calendar day."
        action={
          <span className="rounded border border-[#E2E8F0] px-2 py-[3px] font-mono text-[10px] text-[#64748B]">
            Last 30 days
          </span>
        }
        className="border-t"
      >
        <div className="px-4 py-3">
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="h-20 w-full"
            role="img"
            aria-label="Daily revenue trending upward over the last 30 days"
          >
            <defs>
              <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand-blue)" stopOpacity="0.18" />
                <stop offset="100%" stopColor="var(--brand-blue)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[10, 20, 30].map((y) => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="100"
                y2={y}
                stroke="#E9EFF6"
                strokeWidth="0.4"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polygon fill="url(#rev)" points={`0,40 ${SPARK} 100,40`} />
            <polyline
              fill="none"
              stroke="var(--brand-blue)"
              strokeWidth="1.6"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              points={SPARK}
            />
          </svg>
        </div>
      </Panel>

      <div className="grid border-t border-[#E9EFF6] sm:grid-cols-2">
        <Panel title="By item type" className="border-[#E9EFF6] sm:border-r">
          <ul className="divide-y divide-[#F1F5F9]">
            {ITEM_TYPES.map(([name, orders, amount, pct]) => (
              <li key={name} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[12px] text-[#0F172A]">
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] font-medium tabular-nums text-[#0A1128]">
                    {amount}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-[#F1F5F9]">
                    <span
                      className="block h-full rounded-full bg-[var(--brand-blue)]"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="font-mono text-[10px] text-[#64748B]">
                    {orders}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Top staff">
          <ul className="divide-y divide-[#F1F5F9]">
            {TOP_STAFF.map(([name, orders, amount]) => (
              <li
                key={name}
                className="flex items-center gap-3 px-4 py-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-[#0F172A]">
                  {name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[#64748B]">
                  {orders}
                </span>
                <span className="shrink-0 font-mono text-[11.5px] font-medium tabular-nums text-[#0A1128]">
                  {amount}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="border-t border-[#E9EFF6] bg-[#F8FAFC] px-4 py-2 text-[10.5px] text-[#64748B]">
        Illustrative figures — not a customer&apos;s data.
      </div>
    </ProductFrame>
  );
}

/* ─── F · Files + evidence ─────────────────────────────────────────────── */

function FilesMedia() {
  return (
    <ProductFrame label="/app/customers/northwind-studio#files">
      <Panel title="Files" caption="Attached to the client, not a folder tree">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Attached to</Th>
                <Th>Added</Th>
              </tr>
            </thead>
            <tbody>
              {[
                ["scope-v3-signed.pdf", "Client · agreement", "12 Feb"],
                ["brand-pack-v3.zip", "Order #1042", "28 Feb"],
                ["INV-0114.pdf", "Invoice · paid", "3 Mar"],
                ["receipt-0114.pdf", "Payment · confirmed", "Today"],
              ].map(([file, attached, added]) => (
                <tr key={file}>
                  <Td mono strong>
                    {file}
                  </Td>
                  <Td>{attached}</Td>
                  <Td mono>{added}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="border-t border-[#E9EFF6] px-4 py-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
          Why it matters
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[#4A5568]">
          When a payment is queried months later, the order, the agreement, the
          invoice and the receipt are already in one place — in the order they
          happened.
        </p>
      </div>
    </ProductFrame>
  );
}

/* ─── The walkthrough ──────────────────────────────────────────────────── */

export function Walkthrough() {
  return (
    <Section id="product" className="py-0 sm:py-0">
      <div className="divide-y divide-[#E9EFF6]">
        <Block
          id="demo"
          eyebrow="Client timeline"
          title="Every client interaction, in one timeline."
          copy="Stop reconstructing client history from inboxes, spreadsheets and a payment dashboard. The operational history stays attached to the client, in the order it happened."
          points={[
            "Orders, invoices, payments and sent email on one thread",
            "Files and agreements land on the timeline with their date",
            "Status changes recorded as they happen, not written up after",
            "Readable by whoever picks the account up next",
          ]}
          media={<TimelineMedia />}
        />

        <Block
          eyebrow="Client profile"
          title="One searchable record for every client."
          copy="Search a name, company, email or invoice number and the record opens with the whole relationship already assembled."
          points={[
            "Contact, orders, invoices, payments, files, links and notes",
            "Outstanding balance visible without opening the accounting tool",
            "No per-client spreadsheet to keep in step",
          ]}
          media={<ProfileMedia />}
          flip
        />

        <Block
          eyebrow="Orders + fulfilment"
          title="Turn a payment into an organised delivery workflow."
          copy="An order carries both halves: what the client bought, and where the work has got to. The stages are the ones your business already uses — you name them."
          points={[
            "Configurable status workflow per workspace",
            "Numbered invoices and receipts generated from the order",
            "Card payment through your own Stripe account",
            "Delivery recorded against the transaction, not beside it",
          ]}
          media={<OrdersMedia />}
        />

        <Block
          eyebrow="Client email"
          title="Send client email without leaving the record."
          copy="Compose with the order in view, from templates that fill the client, amount and payment link from the record itself. What you sent is then part of the history."
          points={[
            "Templates per workspace, with the order's own values filled in",
            "The client and amount on screen while you write",
            "Every send recorded against the client",
            "No copy-paste between a dashboard and an inbox",
          ]}
          media={<EmailMedia />}
          flip
        />

        <Block
          eyebrow="Analytics"
          title="Know what is happening across the business."
          copy="Revenue, average order, conversion and what is still outstanding, with the breakdown by service and by team member — from the orders and payments you already recorded."
          points={[
            "Revenue and order performance over a date range",
            "Which services actually generate the revenue",
            "Conversion and outstanding orders in one view",
            "No manual joining of exports from three tools",
          ]}
          media={<AnalyticsMedia />}
        />

        <Block
          eyebrow="Files + evidence"
          title="Keep the files and the context attached to the transaction."
          copy="Agreements, deliverables, invoices and receipts attach to the client and the order, so the evidence chain is assembled before anyone needs it."
          points={[
            "Files attach to the client and to the specific order",
            "Signed scope stored with the date it was agreed",
            "Receipts and invoices alongside the payment that produced them",
            "A tamper-evident audit trail of the important actions",
          ]}
          media={<FilesMedia />}
          flip
        />
      </div>
    </Section>
  );
}
