import {
  CardSkeleton,
  MetricGridSkeleton,
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/common/skeletons";

export default function DisputesLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton withEyebrow titleWidth="16rem" />
      <MetricGridSkeleton count={3} />
      <TableSkeleton rows={4} columns={6} withToolbar />
      <CardSkeleton lines={4} />
    </div>
  );
}
