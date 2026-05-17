import {
  FormSkeleton,
  PageHeaderSkeleton,
} from "@/components/common/skeletons";

export default function SettingsLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="13rem" />
      <FormSkeleton sections={3} rows={2} />
    </div>
  );
}
