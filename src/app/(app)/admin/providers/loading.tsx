import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/common/skeletons";

export default function ProvidersLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="11rem" withActions />
      <TableSkeleton
        rows={5}
        columns={6}
        columnWidths={["3.5rem", "12rem", "8rem", "8rem", "6rem", "2.5rem"]}
      />
    </div>
  );
}
