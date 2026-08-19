import { getDashboardMetrics } from "@/console/server/services/metrics";
import { Card, StatTile } from "@/console/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const m = await getDashboardMetrics();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Overview</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Active users" value={m.activeUsers} hint={`${m.totalUsers} total`} />
        <StatTile label="Active tenants" value={m.activeTenants} tone="good" />
        <StatTile
          label="Recently active"
          value={m.recentlyActive}
          hint="signed in last 7 days"
        />
        <StatTile
          label="Waitlist pending"
          value={m.waitlist.pending}
          hint={`${m.waitlist.total} all-time`}
          tone="warn"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Trials (active tenants)">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="On trial" value={m.trial.active} tone="good" />
            <StatTile label="Ending ≤3d" value={m.trial.expiring} tone="warn" />
            <StatTile label="Expired" value={m.trial.expired} tone="bad" />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            15-day trial window from signup. Everyone is on a trial today —
            paid/free needs a plan model (not tracked yet).
          </p>
        </Card>

        <Card title="Not tracked yet">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Paid vs free" value="—" tone="muted" hint="needs plan model" />
            <StatTile label="Beta cohort" value="—" tone="muted" hint="needs beta flag" />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            These have no backing data in the schema yet. Add
            <code className="mx-1 rounded bg-white/5 px-1">Organization.plan</code>
            and a beta flag to light them up.
          </p>
        </Card>
      </div>

      <Card title="Most active users (last 30 days, by recorded activity)">
        {m.mostActive.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-1">
            {m.mostActive.map((u, i) => (
              <li
                key={u.userId}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
              >
                <span className="text-slate-200">
                  <span className="mr-2 text-[var(--muted)]">{i + 1}.</span>
                  {u.name}
                  <span className="ml-2 text-[12px] text-[var(--muted)]">{u.email}</span>
                </span>
                <span className="text-[13px] font-medium text-slate-300">
                  {u.actions} actions
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
