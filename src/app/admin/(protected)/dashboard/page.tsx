import Link from "next/link";

import { getDashboardMetrics } from "@/console/server/services/metrics";
import { getGrowthMetrics } from "@/console/server/services/growth";
import { Card, StatTile } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
  const [m, g] = await Promise.all([
    getDashboardMetrics(),
    getGrowthMetrics(),
  ]);
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

      {/* ── Growth, content and moderation ─────────────────────────────
          Everything an operator would otherwise have to count by hand:
          what is waiting on them, where leads came from, and whether
          anything is being abused. Each tile links to the page that acts
          on it — a number with no way through to the work is decoration. */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Leads">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Pending" value={g.leads.pending} tone="warn" />
            <StatTile
              label="Last 7 days"
              value={g.leads.recent}
              hint={`${g.leads.total} all-time`}
            />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            {g.leads.attributed} of {g.leads.total} carry campaign attribution.{" "}
            <Link
              href={`${ADMIN_BASE}/beta-applications`}
              className="text-[var(--accent)] hover:underline"
            >
              Review applications →
            </Link>
          </p>
        </Card>

        <Card title="Blog">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Published" value={g.blog.published} tone="good" />
            <StatTile label="Drafts" value={g.blog.drafts} tone="muted" />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            <Link
              href={`${ADMIN_BASE}/blog`}
              className="text-[var(--accent)] hover:underline"
            >
              Write or publish →
            </Link>
          </p>
        </Card>

        <Card title="Reviews">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="Pending" value={g.reviews.pending} tone="warn" />
            <StatTile label="Live" value={g.reviews.approved} tone="good" />
            <StatTile
              label="Rating"
              value={g.reviews.averageRating ?? "—"}
              tone="muted"
              hint={g.reviews.averageRating ? "approved mean" : "needs 2+"}
            />
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            {g.reviews.rejected} rejected.{" "}
            <Link
              href={`${ADMIN_BASE}/reviews`}
              className="text-[var(--accent)] hover:underline"
            >
              Moderate →
            </Link>
          </p>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Where leads come from">
          {g.topSources.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No leads yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {g.topSources.map((s) => (
                <li
                  key={s.source}
                  className="flex items-center justify-between text-[13px]"
                >
                  <span className="text-slate-200">{s.source}</span>
                  <span className="text-[var(--muted)]">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Stated plainly: an unlabelled attribution chart gets read as
              complete, and this one is not. */}
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            Attribution is captured on the visitor&apos;s first page and only
            when a campaign tagged the link. Direct visits and every lead from
            before attribution shipped fall into &ldquo;Direct /
            unknown&rdquo;.
          </p>
        </Card>

        <Card title="Landing pages that convert">
          {g.topLandingPages.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No leads yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {g.topLandingPages.map((l) => (
                <li
                  key={l.path}
                  className="flex items-center justify-between text-[13px]"
                >
                  <span className="font-mono text-slate-200">{l.path}</span>
                  <span className="text-[var(--muted)]">{l.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            The page a lead ARRIVED on, not the page they submitted from.
            Query strings are never stored, so no token can appear here.
          </p>
        </Card>
      </div>

      <Card title="Abuse controls">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="Disposable domains blocked"
            value={g.abuse.blockedDomains}
            hint="every public form"
          />
          <StatTile
            label="Repeat reviewers"
            value={g.abuse.repeatReviewers}
            tone={g.abuse.repeatReviewers ? "warn" : "muted"}
            hint="same email, 2+ reviews"
          />
        </div>
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Public forms are additionally protected by Turnstile, per-route rate
          limits and a body-size cap. Repeat reviewers are context for a
          moderator, not a verdict — a returning customer with more to say
          looks identical here to a scripted submitter.
        </p>
      </Card>

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
