/**
 * One fictional client record, shared by the hero preview and the
 * interactive product demo so the story stays consistent across the
 * page: the agency searches "Vela", opens Vela Skincare, and every
 * later section shows the *same* record deepening — invoices, payments,
 * approvals, a full timeline.
 *
 * Deliberately mundane and specific. Real agency work looks like this:
 * a deposit, a couple of approvals, a final invoice, a delivery. The
 * believability is the point — visitors should recognise their own
 * clients, not a demo.
 */

export type TimelineKind =
  | "client"
  | "note"
  | "agreement"
  | "invoice"
  | "payment"
  | "approval"
  | "document"
  | "delivery";

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  /** Human date shown in the UI. */
  date: string;
  /** Optional money amount, major units USD. */
  amount?: number;
  /** Optional status pill copy. */
  status?: string;
}

export interface DemoClient {
  name: string;
  company: string;
  initials: string;
  handle: string;
  since: string;
  tags: string[];
  totals: {
    billed: number;
    paid: number;
    invoices: number;
    approvals: number;
    documents: number;
  };
  /** Oldest → newest. Reverse at the render site for a feed. */
  timeline: TimelineEvent[];
}

export const DEMO_CLIENT: DemoClient = {
  name: "Vela Skincare",
  company: "Vela Skincare, Inc.",
  initials: "VS",
  handle: "vela-skincare",
  since: "Jan 2025",
  tags: ["Brand + Web", "Retainer-ready", "Priority"],
  totals: {
    billed: 13000,
    paid: 13000,
    invoices: 2,
    approvals: 4,
    documents: 6,
  },
  timeline: [
    {
      id: "t1",
      kind: "client",
      title: "Client created",
      detail: "Added by Maya after the intro call",
      date: "Jan 8, 2025",
    },
    {
      id: "t2",
      kind: "agreement",
      title: "Master services agreement signed",
      detail: "Scope: brand identity + Shopify build. v2, countersigned.",
      date: "Jan 12, 2025",
      status: "Signed",
    },
    {
      id: "t3",
      kind: "invoice",
      title: "Invoice INV-1042 sent",
      detail: "50% project deposit",
      date: "Jan 12, 2025",
      amount: 6500,
      status: "Sent",
    },
    {
      id: "t4",
      kind: "payment",
      title: "Payment received",
      detail: "Card · deposit cleared",
      date: "Jan 14, 2025",
      amount: 6500,
      status: "Paid",
    },
    {
      id: "t5",
      kind: "approval",
      title: "Brand direction approved",
      detail: "“Direction B — the warm one.” — Priya, Vela",
      date: "Jan 28, 2025",
      status: "Approved",
    },
    {
      id: "t6",
      kind: "approval",
      title: "Homepage design approved",
      detail: "Staging link v4 signed off, no changes requested",
      date: "Feb 20, 2025",
      status: "Approved",
    },
    {
      id: "t7",
      kind: "invoice",
      title: "Invoice INV-1061 sent",
      detail: "Final 50% on delivery",
      date: "Mar 2, 2025",
      amount: 6500,
      status: "Sent",
    },
    {
      id: "t8",
      kind: "payment",
      title: "Payment received",
      detail: "Bank transfer · final balance",
      date: "Mar 5, 2025",
      amount: 6500,
      status: "Paid",
    },
    {
      id: "t9",
      kind: "delivery",
      title: "Project delivered",
      detail: "Handoff pack + brand guidelines shared",
      date: "Mar 8, 2025",
      status: "Delivered",
    },
  ],
};

/** Search suggestions for the hero's command-bar animation. */
export interface DemoSearchResult {
  label: string;
  meta: string;
  primary?: boolean;
}

export const DEMO_SEARCH_RESULTS: DemoSearchResult[] = [
  { label: "Vela Skincare", meta: "Client · Brand + Web", primary: true },
  { label: "INV-1042", meta: "Invoice · $6,500 · Paid" },
  { label: "MSA — Vela Skincare", meta: "Agreement · Signed Jan 12" },
  { label: "Brand direction approval", meta: "Approval · Jan 28" },
];

export function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}
