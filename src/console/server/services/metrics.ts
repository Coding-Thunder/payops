import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { Organization, Quotation, User, Types } from "@/console/server/db/models";

const DAY = 24 * 60 * 60 * 1000;
const TRIAL_MS = 15 * DAY;
const WARN_MS = 12 * DAY; // 12–15 days elapsed => 0–3 days left
const RECENT_MS = 7 * DAY;
const ACTIVITY_WINDOW_MS = 30 * DAY;

export interface MostActiveUser {
  userId: string;
  name: string;
  email: string;
  actions: number;
}

export interface DashboardMetrics {
  activeUsers: number;
  totalUsers: number;
  activeTenants: number;
  recentlyActive: number;
  trial: { active: number; expiring: number; expired: number };
  waitlist: { pending: number; total: number };
  mostActive: MostActiveUser[];
  /** Metrics the data model can't back yet — surfaced as "not tracked". */
  notTracked: string[];
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const conn = await connectMongo();
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - RECENT_MS);
  const activityCutoff = new Date(now.getTime() - ACTIVITY_WINDOW_MS);

  const [activeUsers, totalUsers, activeTenants, recentlyActive, waitlistPending, waitlistTotal] =
    await Promise.all([
      User.countDocuments({ status: "ACTIVE" }),
      User.countDocuments({}),
      Organization.countDocuments({ status: "ACTIVE" }),
      User.countDocuments({ lastLoginAt: { $gte: recentCutoff } }),
      Quotation.countDocuments({ source: "waitlist", status: "PENDING" }),
      Quotation.countDocuments({ source: "waitlist" }),
    ]);

  // Trial funnel over ACTIVE tenants: effective start = trialStartsAt or
  // createdAt (mirrors the main app's fallback), bucketed by elapsed time.
  const trialAgg = await Organization.aggregate<{ _id: string; n: number }>([
    { $match: { status: "ACTIVE" } },
    { $project: { start: { $ifNull: ["$trialStartsAt", "$createdAt"] } } },
    { $project: { elapsed: { $subtract: [now, "$start"] } } },
    {
      $project: {
        bucket: {
          $switch: {
            branches: [
              { case: { $gte: ["$elapsed", TRIAL_MS] }, then: "expired" },
              { case: { $gte: ["$elapsed", WARN_MS] }, then: "expiring" },
            ],
            default: "active",
          },
        },
      },
    },
    { $group: { _id: "$bucket", n: { $sum: 1 } } },
  ]);
  const trial = { active: 0, expiring: 0, expired: 0 };
  for (const row of trialAgg) {
    if (row._id === "expired") trial.expired = row.n;
    else if (row._id === "expiring") trial.expiring = row.n;
    else trial.active = row.n;
  }

  // Most active users: group the main app's audit_logs by actor.userId
  // over the last 30 days (native driver to avoid schema coupling).
  const db = conn.connection.db;
  let mostActive: MostActiveUser[] = [];
  if (db) {
    const rows = await db
      .collection("audit_logs")
      .aggregate<{ _id: unknown; count: number }>([
        { $match: { createdAt: { $gte: activityCutoff } } },
        { $group: { _id: "$actor.userId", count: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();

    const ids = rows
      .map((r) => r._id)
      .filter((v): v is Types.ObjectId | string => v != null)
      .flatMap((v) => {
        if (v instanceof Types.ObjectId) return [v];
        const s = String(v);
        return Types.ObjectId.isValid(s) ? [new Types.ObjectId(s)] : [];
      });

    const users = await User.find({ _id: { $in: ids } })
      .select({ name: 1, email: 1 })
      .lean<{ _id: Types.ObjectId; name: string; email: string }[]>();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    mostActive = rows.map((r) => {
      const key = String(r._id);
      const u = byId.get(key);
      return {
        userId: key,
        name: u?.name ?? "(unknown)",
        email: u?.email ?? "",
        actions: r.count,
      };
    });
  }

  return {
    activeUsers,
    totalUsers,
    activeTenants,
    recentlyActive,
    trial,
    waitlist: { pending: waitlistPending, total: waitlistTotal },
    mostActive,
    notTracked: ["paid_vs_free", "beta"],
  };
}
