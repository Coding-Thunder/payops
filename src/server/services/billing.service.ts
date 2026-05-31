import "server-only";

import { Types } from "mongoose";

import { OrderStatus } from "@/lib/constants/enums";
import { QuotaExceededError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Billing + plan enforcement.
 *
 * v1 reality (2026-05-31): Stripe Billing is not wired up. Every
 * tenant is on Starter until billing ships, so `getCurrentPlan` is
 * a constant. The shape is here — and PLAN_LIMITS already lists all
 * three tiers — so when billing arrives the only change is
 * `getCurrentPlan` reading `Organization.plan`.
 *
 * "Active orders" here = orders with non-terminal status. The
 * marketing copy says "active orders" and the decision (2026-05-31)
 * is to meter concurrent open work-in-progress, not monthly
 * throughput. Terminal statuses (PAID, FAILED, EXPIRED) do not
 * count against the cap — once payment resolves either way, the
 * order is "done" and frees a slot.
 */

export type PlanKey = "starter" | "growth" | "scale";

export interface PlanDef {
  key: PlanKey;
  name: string;
  /** Concurrent active-order cap. `Infinity` for unlimited. */
  activeOrderLimit: number;
}

export const PLAN_LIMITS: Record<PlanKey, PlanDef> = {
  starter: { key: "starter", name: "Starter", activeOrderLimit: 30 },
  growth: { key: "growth", name: "Growth", activeOrderLimit: 150 },
  scale: { key: "scale", name: "Scale", activeOrderLimit: Infinity },
};

/** Order statuses that count against the active-orders cap. Anything
 *  reaching a terminal status (PAID, FAILED, EXPIRED) is excluded. */
const ACTIVE_STATUSES: readonly string[] = [
  OrderStatus.NOT_INITIATED,
  OrderStatus.LINK_GENERATED,
  OrderStatus.PAYMENT_PENDING,
];

/**
 * Resolve the plan for an org. Today: always Starter. When billing
 * ships, replace with `Organization.findById(orgId).select("plan")`
 * and fall back to Starter when unset. Legacy callers (no orgId) get
 * Starter too — they're the single-tenant migration window and
 * counting their orders separately would understate usage.
 */
export async function getCurrentPlan(_orgId: string | null): Promise<PlanDef> {
  return PLAN_LIMITS.starter;
}

/**
 * Count orders in a non-terminal status for this tenant. Uses the
 * `(orgId, status, createdAt)` partial index already on the Order
 * collection, so this stays cheap even at the Scale tier.
 *
 * Legacy callers (orgId === null) are not counted — they're either
 * the single-tenant migration window or tests; metering them would
 * conflate tenants. Routes that pass a real orgId get the real cap.
 */
export async function countActiveOrders(orgId: string | null): Promise<number> {
  if (!orgId) return 0;
  await connectMongo();
  return Order.countDocuments({
    orgId: new Types.ObjectId(orgId),
    status: { $in: ACTIVE_STATUSES },
  });
}

export interface QuotaSnapshot {
  plan: PlanDef;
  current: number;
  limit: number;
  remaining: number;
  /** True when current >= limit. UI uses this for a hard-stop banner. */
  atLimit: boolean;
}

export async function getOrderQuotaSnapshot(
  orgId: string | null,
): Promise<QuotaSnapshot> {
  const plan = await getCurrentPlan(orgId);
  const current = await countActiveOrders(orgId);
  const limit = plan.activeOrderLimit;
  const remaining = Number.isFinite(limit) ? Math.max(0, limit - current) : Infinity;
  return {
    plan,
    current,
    limit,
    remaining,
    atLimit: Number.isFinite(limit) && current >= limit,
  };
}

/**
 * Throws `QuotaExceededError` (HTTP 402) when the tenant has hit
 * their active-orders cap. Called at the top of every order-create
 * path so the gate sits in one place — the UI can't bypass it by
 * routing through a different endpoint.
 */
export async function assertCanCreateOrder(orgId: string | null): Promise<void> {
  if (!orgId) return; // legacy migration window — no metering
  const snapshot = await getOrderQuotaSnapshot(orgId);
  if (!snapshot.atLimit) return;
  throw new QuotaExceededError(
    `You've reached your ${snapshot.plan.name} plan limit of ${snapshot.limit} active orders. Resolve a pending order or upgrade to create more.`,
    {
      plan: snapshot.plan.key,
      resource: "active_orders",
      limit: snapshot.limit,
      current: snapshot.current,
    },
  );
}
