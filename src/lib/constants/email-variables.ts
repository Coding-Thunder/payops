/**
 * Contextual email variables.
 *
 * One registry, shared by the composer, the template editor, the
 * preview renderer, and the send path — so "what can I insert", "what
 * does the preview show", and "what actually goes out" can never drift.
 *
 * Two kinds of variable:
 *   - `auto`   — TraceTxn already knows it (client, business, order,
 *                invoice, payment). Resolved from context at send time;
 *                the operator never types it.
 *   - `prompt` — only the operator knows it for THIS message (a meeting
 *                link, a date, a next step). The composer collects it
 *                inline, and only when the copy actually uses it.
 *
 * The point of the split is the product rule from the brief: don't force
 * every email to carry the same variables. A project update surfaces
 * order fields, a meeting invite surfaces meeting fields, a payment
 * chase surfaces invoice fields — because the copy asked for them.
 */

export const EMAIL_VARIABLE_GROUPS = [
  "client",
  "business",
  "order",
  "invoice",
  "meeting",
  "project",
] as const;
export type EmailVariableGroup = (typeof EMAIL_VARIABLE_GROUPS)[number];

export const EMAIL_VARIABLE_GROUP_LABELS: Record<EmailVariableGroup, string> = {
  client: "Client",
  business: "Business",
  order: "Order",
  invoice: "Invoice & payment",
  meeting: "Meeting or call",
  project: "Project update",
};

/**
 * What must be true for a variable to resolve to a real value.
 *   always  — client + business context, present on every send.
 *   order   — the email is attached to an order.
 *   payment — the order has an invoice / payment link / settlement.
 *   manual  — the operator supplies it in the composer.
 */
export type EmailVariableRequires = "always" | "order" | "payment" | "manual";

export interface EmailVariableSpec {
  /** Bare token name. The wire form is `{{token}}`. */
  token: string;
  label: string;
  group: EmailVariableGroup;
  requires: EmailVariableRequires;
  /** Realistic stand-in used by every preview surface. */
  sample: string;
  /** Placeholder shown on the prompt input (manual variables only). */
  placeholder?: string;
}

export const EMAIL_VARIABLES: readonly EmailVariableSpec[] = [
  // ── Client (always available — the composer is opened from a client)
  {
    token: "client_name",
    label: "Client name",
    group: "client",
    requires: "always",
    sample: "Jane Smith",
  },
  {
    token: "client_email",
    label: "Client email",
    group: "client",
    requires: "always",
    sample: "jane@example.com",
  },
  {
    token: "client_company",
    label: "Client company",
    group: "client",
    requires: "always",
    sample: "ABC Company",
  },
  // ── Business
  {
    token: "business_name",
    label: "Business name",
    group: "business",
    requires: "always",
    sample: "Northwind Studio",
  },
  {
    token: "sender_name",
    label: "Your name",
    group: "business",
    requires: "always",
    sample: "Yogesh",
  },
  // ── Order
  {
    token: "order_name",
    label: "Order name",
    group: "order",
    requires: "order",
    sample: "Website Development",
  },
  {
    token: "order_id",
    label: "Order ID",
    group: "order",
    requires: "order",
    sample: "ORD-260517-PREVW1",
  },
  {
    token: "order_amount",
    label: "Order amount",
    group: "order",
    requires: "order",
    sample: "$2,400.00",
  },
  {
    token: "order_status",
    label: "Order status",
    group: "order",
    requires: "order",
    sample: "In progress",
  },
  // ── Invoice & payment
  {
    token: "invoice_number",
    label: "Invoice number",
    group: "invoice",
    requires: "payment",
    sample: "INV-2026-0001",
  },
  {
    token: "invoice_amount",
    label: "Invoice amount",
    group: "invoice",
    requires: "payment",
    sample: "$2,400.00",
  },
  {
    token: "due_date",
    label: "Due date",
    group: "invoice",
    requires: "payment",
    sample: "5 June 2026",
  },
  {
    token: "payment_link",
    label: "Payment link",
    group: "invoice",
    requires: "payment",
    sample: "https://pay.example.com/inv-2026-0001",
  },
  {
    token: "payment_amount",
    label: "Amount paid",
    group: "invoice",
    requires: "payment",
    sample: "$2,400.00",
  },
  {
    token: "payment_date",
    label: "Payment date",
    group: "invoice",
    requires: "payment",
    sample: "2 June 2026",
  },
  // ── Meeting / call (operator-supplied)
  {
    token: "meeting_link",
    label: "Meeting link",
    group: "meeting",
    requires: "manual",
    sample: "https://meet.google.com/abc-defg-hij",
    placeholder: "https://meet.google.com/…",
  },
  {
    token: "meeting_date",
    label: "Meeting date",
    group: "meeting",
    requires: "manual",
    sample: "Thursday, 4 June",
    placeholder: "Thursday, 4 June",
  },
  {
    token: "meeting_time",
    label: "Meeting time",
    group: "meeting",
    requires: "manual",
    sample: "3:00 PM IST",
    placeholder: "3:00 PM IST",
  },
  // ── Project update (operator-supplied)
  {
    token: "current_status",
    label: "Current status",
    group: "project",
    requires: "manual",
    sample: "Design review complete",
    placeholder: "Design review complete",
  },
  {
    token: "project_update",
    label: "Update details",
    group: "project",
    requires: "manual",
    sample: "Both homepage variants are ready for your review.",
    placeholder: "What moved this week…",
  },
  {
    token: "next_step",
    label: "Next step",
    group: "project",
    requires: "manual",
    sample: "Your sign-off on the homepage direction.",
    placeholder: "What you need from the client…",
  },
];

const BY_TOKEN = new Map(EMAIL_VARIABLES.map((v) => [v.token, v]));

export function findVariable(token: string): EmailVariableSpec | null {
  return BY_TOKEN.get(token) ?? null;
}

/** The wire form an editor inserts. */
export function variableToken(token: string): string {
  return `{{${token}}}`;
}

/** Matches `{{token}}` with optional inner whitespace. Global — clone
 *  or reset `lastIndex` before reuse. */
export const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every registry token used across the given strings, in first-seen
 *  order. Unknown tokens are ignored (they render as-is). */
export function extractVariables(...texts: Array<string | null | undefined>): string[] {
  const seen: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const re = new RegExp(VARIABLE_PATTERN.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const token = m[1];
      if (!BY_TOKEN.has(token)) continue;
      if (!seen.includes(token)) seen.push(token);
    }
  }
  return seen;
}

/** The `manual` variables the copy actually uses — exactly the inputs
 *  the composer should ask for, and nothing more. */
export function manualVariablesUsed(
  ...texts: Array<string | null | undefined>
): EmailVariableSpec[] {
  return extractVariables(...texts)
    .map((t) => BY_TOKEN.get(t))
    .filter((v): v is EmailVariableSpec => Boolean(v) && v!.requires === "manual");
}

export interface VariableAvailability {
  /** The send is attached to an order. */
  order: boolean;
  /** The order carries invoice / payment-link / settlement data. */
  payment: boolean;
}

/** Which variables the Insert menu should offer, given what this send
 *  actually knows. Manual variables are always offerable — that's the
 *  whole point of them. */
export function availableVariables(
  availability: VariableAvailability,
): EmailVariableSpec[] {
  return EMAIL_VARIABLES.filter((v) => {
    if (v.requires === "always" || v.requires === "manual") return true;
    if (v.requires === "order") return availability.order;
    return availability.payment;
  });
}

/** Group the offerable variables for a menu, dropping empty groups. */
export function groupedVariables(
  availability: VariableAvailability,
): Array<{ group: EmailVariableGroup; label: string; items: EmailVariableSpec[] }> {
  const offerable = availableVariables(availability);
  return EMAIL_VARIABLE_GROUPS.map((group) => ({
    group,
    label: EMAIL_VARIABLE_GROUP_LABELS[group],
    items: offerable.filter((v) => v.group === group),
  })).filter((g) => g.items.length > 0);
}

/**
 * Substitute `{{token}}` with resolved values.
 *
 * An unresolved KNOWN token collapses to an empty string rather than
 * leaking `{{order_name}}` into a customer's inbox. An UNKNOWN token is
 * left verbatim — it isn't ours, so it's probably literal copy.
 */
export function renderVariables(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
): string {
  return text.replace(VARIABLE_PATTERN, (whole, token: string) => {
    if (!BY_TOKEN.has(token)) return whole;
    const value = values[token];
    return value == null ? "" : String(value);
  });
}

/** Every registry token mapped to its sample value — the substitution
 *  map every preview surface uses. */
export function sampleValues(): Record<string, string> {
  return Object.fromEntries(EMAIL_VARIABLES.map((v) => [v.token, v.sample]));
}
