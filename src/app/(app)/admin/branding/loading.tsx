import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FormSkeleton,
  PageHeaderSkeleton,
} from "@/components/common/skeletons";

export default function BrandingLoading() {
  return (
    <div className="space-y-6" aria-busy aria-live="polite">
      <PageHeaderSkeleton titleWidth="12rem" />
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-72" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
          <FormSkeleton sections={1} rows={2} withFooter={false} />
        </CardContent>
      </Card>
      <FormSkeleton sections={1} rows={1} />
    </div>
  );
}
