import {
  FormSkeleton,
  PageHeaderSkeleton,
} from "@/components/common/skeletons";

export default function CreateOrderLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="9rem" />
      <FormSkeleton sections={4} rows={2} />
    </div>
  );
}
