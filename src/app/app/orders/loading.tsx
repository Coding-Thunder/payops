import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/common/skeletons";

export default function OrdersLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="9rem" withActions />
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-2 md:flex-row md:items-center">
        <Skeleton className="h-8 flex-1 max-w-md rounded-md" />
        <Skeleton className="h-8 w-full md:w-48 rounded-md" />
        <Skeleton className="h-8 w-full md:w-52 rounded-md" />
      </div>
      <TableSkeleton rows={8} columns={8} />
      <div className="flex items-center justify-end gap-2">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
    </div>
  );
}
