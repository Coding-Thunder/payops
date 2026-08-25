import "server-only";

import { Types } from "mongoose";

import { RecordState } from "@/lib/constants/enums";
import { EMAIL_VARIABLES } from "@/lib/constants/email-variables";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  Customer,
  Document as DocumentModel,
  DocumentKind,
  Order,
  type CustomerDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";
import { getBranding } from "@/server/services/branding.service";
import { listAllTemplatesSummary, getActiveTemplate } from "@/server/services/email-template.service";
import type { ComposeContextDTO } from "@/types";

/**
 * Everything the email system knows without being told.
 *
 * The product rule: "Do not make the user select or manually enter
 * information that TraceTxn already knows." This module is where that
 * rule is actually implemented — it turns (org, client, order) into the
 * resolved variable values the composer, the preview, and the send path
 * all share.
 *
 * Crucially, resolution happens SERVER-SIDE from the tenant's own
 * records. The browser may supply `manual` values (a meeting link, a
 * date the operator typed) and nothing else, so a tampered compose
 * payload cannot inject another client's name or another order's amount
 * into an outgoing email.
 */

/** Names that a browser is allowed to fill in. Everything else is
 *  resolved from the database, whatever the request claims. */
const MANUAL_TOKENS = new Set(
  EMAIL_VARIABLES.filter((v) => v.requires === "manual").map((v) => v.token),
);

export interface ResolveVariablesArgs {
  orgId: string;
  customerId: string;
  orderId?: string | null;
  actorName: string;
  /** Operator-supplied fills for `manual` variables. */
  manual?: Record<string, string>;
}

export interface ResolvedEmailContext {
  values: Record<string, string>;
  client: { id: string; name: string; email: string; company: string | null };
  brandName: string;
  order: {
    id: string;
    orderNumber: string;
    label: string;
    hasPayment: boolean;
  } | null;
}

/**
 * Resolve the variable map for one send.
 *
 * Auto variables that have no value in this context resolve to an empty
 * string rather than being left as `{{order_name}}` — a customer must
 * never receive raw template syntax. The composer's job is to make that
 * rare by only offering variables the context can actually satisfy; this
 * is the backstop for a template written against an order and then sent
 * without one.
 */
export async function resolveEmailContext(
  args: ResolveVariablesArgs,
): Promise<ResolvedEmailContext> {
  const scopedOrgId = requireOrgId(args.orgId);
  await connectMongo();
  const orgFilter = orgIdFilter(scopedOrgId);

  if (!Types.ObjectId.isValid(args.customerId)) {
    throw new NotFoundError("Client not found");
  }
  const customer = await Customer.findOne({
    _id: new Types.ObjectId(args.customerId),
    orgId: orgFilter,
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  if (!customer) throw new NotFoundError("Client not found");

  const branding = await getBranding(scopedOrgId);

  const values: Record<string, string> = {
    client_name: customer.name ?? "",
    client_email: customer.email ?? "",
    client_company: customer.company ?? "",
    business_name: branding.brandName,
    sender_name: args.actorName,
  };

  let orderSummary: ResolvedEmailContext["order"] = null;

  if (args.orderId) {
    if (!Types.ObjectId.isValid(args.orderId)) {
      throw new NotFoundError("Order not found");
    }
    const order = await Order.findOne({
      _id: new Types.ObjectId(args.orderId),
      orgId: orgFilter,
    }).lean<{
      _id: Types.ObjectId;
      orderNumber?: string;
      status?: string;
      customerId?: Types.ObjectId | null;
      pricing?: { amount?: number; currency?: string } | null;
      payment?: {
        checkoutUrl?: string | null;
        paidAt?: Date | null;
        expiresAt?: Date | null;
        amountReceived?: number | null;
      } | null;
      lineItems?: Array<{ name?: string }> | null;
    }>();
    if (!order) throw new NotFoundError("Order not found");
    // Same cross-client guard the Files service applies: an order that
    // belongs to someone else must not leak its amounts into this email.
    if (
      order.customerId &&
      String(order.customerId) !== String(customer._id)
    ) {
      throw new ValidationError("That order belongs to a different client");
    }

    const currency = order.pricing?.currency ?? "USD";
    const amount = order.pricing?.amount;
    // "Order name" is what a human calls the work — the first line item
    // ("Website Development"), not the machine reference. The order
    // number is still available as its own variable.
    const label = order.lineItems?.[0]?.name?.trim() || order.orderNumber || "";

    values.order_name = label;
    values.order_id = order.orderNumber ?? "";
    values.order_amount =
      typeof amount === "number" ? formatCurrency(amount, currency) : "";
    values.order_status = humaniseStatus(order.status);

    const invoice = await DocumentModel.findOne({
      orgId: orgFilter,
      orderId: order._id,
      kind: DocumentKind.INVOICE,
    })
      .sort({ issuedAt: -1 })
      .select({ number: 1 })
      .lean<{ number?: string }>();

    values.invoice_number = invoice?.number ?? "";
    values.invoice_amount =
      typeof amount === "number" ? formatCurrency(amount, currency) : "";
    values.due_date = order.payment?.expiresAt
      ? formatDate(order.payment.expiresAt)
      : "";
    values.payment_link = order.payment?.checkoutUrl ?? "";
    values.payment_amount =
      typeof order.payment?.amountReceived === "number"
        ? formatCurrency(order.payment.amountReceived, currency)
        : typeof amount === "number"
          ? formatCurrency(amount, currency)
          : "";
    values.payment_date = order.payment?.paidAt
      ? formatDate(order.payment.paidAt)
      : "";

    orderSummary = {
      id: String(order._id),
      orderNumber: order.orderNumber ?? "—",
      label,
      hasPayment: Boolean(
        invoice?.number ||
          order.payment?.checkoutUrl ||
          order.payment?.paidAt,
      ),
    };
  }

  // Operator-supplied values last, and ONLY for manual tokens. A payload
  // claiming `client_name: "…"` is ignored on purpose.
  for (const [token, value] of Object.entries(args.manual ?? {})) {
    if (!MANUAL_TOKENS.has(token)) continue;
    values[token] = value;
  }

  // Any registry token still unset resolves to "" so no `{{token}}`
  // survives into a customer's inbox.
  for (const spec of EMAIL_VARIABLES) {
    if (values[spec.token] === undefined) values[spec.token] = "";
  }

  return {
    values,
    client: {
      id: String(customer._id),
      name: customer.name ?? "",
      email: customer.email ?? "",
      company: customer.company ?? null,
    },
    brandName: branding.brandName,
    order: orderSummary,
  };
}

/** "PAYMENT_PENDING" → "Payment pending". Workflow statuses are free
 *  strings per tenant, so this is presentation, not a lookup table. */
function humaniseStatus(status?: string | null): string {
  if (!status) return "";
  const spaced = status.replace(/[_-]+/g, " ").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Seed data for opening the composer: who we're writing to, which orders
 * the message can be attributed to, and the tenant's own templates
 * (subject + body already expanded so picking one is instant).
 *
 * Automated transactional templates are deliberately EXCLUDED. They fire
 * from workflow events with an order-shaped layout (line items, payment
 * CTA, consent terms); offering them in a free-text composer is what
 * produced the "I picked Meeting Time and got a Payment Receipt"
 * mismatch in the first place. They're managed in their own section.
 */
export async function buildComposeContext(args: {
  orgId: string;
  customerId: string;
  actorName: string;
}): Promise<ComposeContextDTO> {
  const scopedOrgId = requireOrgId(args.orgId);
  await connectMongo();
  const orgFilter = orgIdFilter(scopedOrgId);

  if (!Types.ObjectId.isValid(args.customerId)) {
    throw new NotFoundError("Client not found");
  }
  const customer = await Customer.findOne({
    _id: new Types.ObjectId(args.customerId),
    orgId: orgFilter,
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  if (!customer) throw new NotFoundError("Client not found");

  const [branding, orderDocs, summaries] = await Promise.all([
    getBranding(scopedOrgId),
    Order.find({
      orgId: orgFilter,
      customerId: customer._id,
      state: { $ne: RecordState.ARCHIVED },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .select({
        orderNumber: 1,
        status: 1,
        pricing: 1,
        lineItems: 1,
        "payment.checkoutUrl": 1,
        "payment.paidAt": 1,
      })
      .lean<
        Array<{
          _id: Types.ObjectId;
          orderNumber?: string;
          status?: string;
          pricing?: { amount?: number; currency?: string } | null;
          lineItems?: Array<{ name?: string }> | null;
          payment?: { checkoutUrl?: string | null; paidAt?: Date | null } | null;
        }>
      >(),
    listAllTemplatesSummary(scopedOrgId),
  ]);

  const customSummaries = summaries.filter((s) => s.kind === "custom");
  const templates = await Promise.all(
    customSummaries.map(async (s) => {
      const active = await getActiveTemplate(s.templateKey, scopedOrgId);
      return {
        templateKey: s.templateKey,
        displayName: s.displayName,
        description: s.description,
        subject: active?.subject ?? s.displayName,
        // Legacy rows have no `body`; fold their slot fields into one so
        // an old template still drops real copy into the composer.
        body: active?.body ?? legacyBody(active),
      };
    }),
  );

  return {
    client: {
      id: String(customer._id),
      name: customer.name ?? "",
      email: customer.email ?? "",
      company: customer.company ?? null,
    },
    business: { name: branding.brandName },
    sender: { name: args.actorName },
    orders: orderDocs.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber ?? "—",
      label: o.lineItems?.[0]?.name?.trim() || o.orderNumber || "Order",
      status: humaniseStatus(o.status),
      amount: o.pricing?.amount ?? 0,
      currency: o.pricing?.currency ?? "USD",
      hasPayment: Boolean(o.payment?.checkoutUrl || o.payment?.paidAt),
    })),
    templates,
  };
}

function legacyBody(
  active: { greeting: string | null; intro: string | null; note: string | null } | null,
): string {
  if (!active) return "";
  return [active.greeting, active.intro, active.note]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
}
