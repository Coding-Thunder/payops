import "server-only";

import { Types } from "mongoose";

import {
  ConsentStatus,
  DisputeStatus,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import { Customer, Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

/**
 * Dashboard read model — the client-centric "command center" surface.
 *
 * Every figure is computed live and tenant-scoped from Orders + Customers;
 * nothing is mocked. The six headline counts come from cheap
 * `countDocuments` calls (covered by the tenant/status indexes); recent
 * client records join each client to their latest order in one aggregation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const PENDING_PAYMENT_STATUSES = [
  OrderStatus.LINK_GENERATED,
  OrderStatus.PAYMENT_PENDING,
];

// "Open" = a dispute that still needs work (everything except WON/LOST).
const OPEN_DISPUTE_STATUSES = [
  DisputeStatus.NEEDS_RESPONSE,
  DisputeStatus.UNDER_REVIEW,
  DisputeStatus.WARNING_NEEDS_RESPONSE,
  DisputeStatus.WARNING_UNDER_REVIEW,
];

export interface DashboardCounts {
  clientRecords: number;
  activeClients: number;
  pendingPayments: number;
  pendingConsents: number;
  flaggedRecords: number;
  disputes: number;
}

export interface DashboardClientRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  latestOrder: {
    id: string;
    orderNumber: string;
    title: string | null;
    status: string;
    paid: boolean;
    consentPending: boolean;
  } | null;
}

export interface DashboardAttentionItem {
  id: string;
  kind: "consent" | "payment_failed" | "flagged";
  title: string;
  subtitle: string;
  href: string;
  actionLabel: string;
}

export interface DashboardData {
  counts: DashboardCounts;
  recentClients: DashboardClientRow[];
  needsAttention: DashboardAttentionItem[];
  hasAnyClients: boolean;
}

type LeanClient = {
  _id: Types.ObjectId;
  name?: string;
  email?: string;
  company?: string | null;
};

type LeanAttentionOrder = {
  _id: Types.ObjectId;
  orderNumber?: string;
  customer?: { name?: string } | null;
};

export async function getDashboardData(
  orgId: string | null | undefined,
): Promise<DashboardData> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const orgFilter = orgIdFilter(scopedOrgId);
  const activeState = { $ne: RecordState.ARCHIVED };
  const thirtyAgo = new Date(Date.now() - 30 * DAY_MS);

  const [
    clientRecords,
    activeClients,
    pendingPayments,
    pendingConsents,
    flaggedRecords,
    disputes,
    clients,
    consentOrders,
    failedOrders,
    flaggedOrders,
  ] = await Promise.all([
    Customer.countDocuments({ orgId: orgFilter }),
    Customer.countDocuments({
      orgId: orgFilter,
      lastOrderAt: { $gte: thirtyAgo },
    }),
    Order.countDocuments({
      orgId: orgFilter,
      state: activeState,
      status: { $in: PENDING_PAYMENT_STATUSES },
    }),
    Order.countDocuments({
      orgId: orgFilter,
      state: activeState,
      "consent.status": ConsentStatus.REQUESTED,
    }),
    Order.countDocuments({
      orgId: orgFilter,
      state: activeState,
      "risk.flagged": true,
    }),
    Order.countDocuments({
      orgId: orgFilter,
      state: activeState,
      "dispute.status": { $in: OPEN_DISPUTE_STATUSES },
    }),
    Customer.find({ orgId: orgFilter })
      .sort({ lastOrderAt: -1, createdAt: -1 })
      .limit(6)
      .select({ name: 1, email: 1, company: 1 })
      .lean<LeanClient[]>(),
    Order.find({
      orgId: orgFilter,
      state: activeState,
      "consent.status": ConsentStatus.REQUESTED,
    })
      .sort({ updatedAt: -1 })
      .limit(4)
      .select({ orderNumber: 1, customer: 1 })
      .lean<LeanAttentionOrder[]>(),
    Order.find({
      orgId: orgFilter,
      state: activeState,
      status: OrderStatus.FAILED,
    })
      .sort({ updatedAt: -1 })
      .limit(4)
      .select({ orderNumber: 1, customer: 1 })
      .lean<LeanAttentionOrder[]>(),
    Order.find({
      orgId: orgFilter,
      state: activeState,
      "risk.flagged": true,
    })
      .sort({ updatedAt: -1 })
      .limit(4)
      .select({ orderNumber: 1, customer: 1 })
      .lean<LeanAttentionOrder[]>(),
  ]);

  // Latest order per recent client, in one grouped aggregation.
  const clientIds = clients.map((c) => c._id);
  const latestByCustomer = new Map<
    string,
    DashboardClientRow["latestOrder"]
  >();
  if (clientIds.length > 0) {
    const agg = await Order.aggregate<{
      _id: Types.ObjectId;
      doc: {
        _id: Types.ObjectId;
        orderNumber?: string;
        status?: string;
        lineItems?: Array<{ name?: string }>;
        payment?: { paidAt?: Date | null } | null;
        consent?: { status?: string } | null;
      };
    }>([
      {
        $match: {
          orgId: orgFilter,
          customerId: { $in: clientIds },
          state: activeState,
        },
      },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$customerId", doc: { $first: "$$ROOT" } } },
    ]);
    for (const row of agg) {
      const d = row.doc;
      latestByCustomer.set(String(row._id), {
        id: String(d._id),
        orderNumber: d.orderNumber ?? "—",
        title: d.lineItems?.[0]?.name ?? null,
        status: d.status ?? "—",
        paid: d.payment?.paidAt != null,
        consentPending: d.consent?.status === ConsentStatus.REQUESTED,
      });
    }
  }

  const recentClients: DashboardClientRow[] = clients.map((c) => ({
    id: String(c._id),
    name: c.name ?? c.email ?? "Client",
    email: c.email ?? "",
    company: c.company ?? null,
    latestOrder: latestByCustomer.get(String(c._id)) ?? null,
  }));

  // Needs Attention — real, actionable items, most urgent first.
  const needsAttention: DashboardAttentionItem[] = [];
  for (const o of consentOrders) {
    needsAttention.push({
      id: `consent:${o._id}`,
      kind: "consent",
      title: `Pending consent — ${o.customer?.name ?? "Client"}`,
      subtitle: `Consent not received for ${o.orderNumber ?? "order"}`,
      href: `/app/orders/${o._id}`,
      actionLabel: "View order",
    });
  }
  for (const o of failedOrders) {
    needsAttention.push({
      id: `failed:${o._id}`,
      kind: "payment_failed",
      title: `Failed payment — ${o.customer?.name ?? "Client"}`,
      subtitle: `Payment attempt failed on ${o.orderNumber ?? "order"}`,
      href: `/app/orders/${o._id}`,
      actionLabel: "View order",
    });
  }
  for (const o of flaggedOrders) {
    needsAttention.push({
      id: `flagged:${o._id}`,
      kind: "flagged",
      title: `Flagged — ${o.customer?.name ?? "Client"}`,
      subtitle: `${o.orderNumber ?? "Order"} is marked for review`,
      href: `/app/orders/${o._id}`,
      actionLabel: "View order",
    });
  }

  return {
    counts: {
      clientRecords,
      activeClients,
      pendingPayments,
      pendingConsents,
      flaggedRecords,
      disputes,
    },
    recentClients,
    needsAttention: needsAttention.slice(0, 6),
    hasAnyClients: clientRecords > 0,
  };
}
