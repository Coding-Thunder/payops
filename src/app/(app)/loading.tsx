import { PageSkeleton } from "@/components/common/skeletons";

/**
 * Fallback loading state for any (app) route that doesn't ship its own
 * tailored skeleton. Each first-class route owns a more specific one.
 */
export default function AppGroupLoading() {
  return <PageSkeleton metrics={4} withTable tableRows={6} />;
}
