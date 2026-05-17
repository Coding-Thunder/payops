import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/common/skeletons";

export default function UsersLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="6rem" withActions />
      <TableSkeleton rows={6} columns={5} />
    </div>
  );
}
