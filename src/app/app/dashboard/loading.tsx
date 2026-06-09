import {
  ActivityFeedSkeleton,
  MetricGridSkeleton,
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/common/skeletons";

export default function DashboardLoading() {
  return (
    <div className="space-y-8" aria-busy aria-live="polite">
      <div className="rounded-2xl border border-border bg-card px-5 py-5 sm:px-8 sm:py-7">
        <PageHeaderSkeleton
          withEyebrow
          withActions
          titleWidth="16rem"
          className="border-0 pb-0"
        />
      </div>
      <MetricGridSkeleton />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-4 w-32 rounded-md bg-surface-2 skeleton-shimmer" />
          <div className="h-6 w-20 rounded-md bg-surface-2 skeleton-shimmer" />
        </div>
        <TableSkeleton rows={5} columns={6} />
      </div>
      <ActivityFeedSkeleton rows={4} />
    </div>
  );
}
