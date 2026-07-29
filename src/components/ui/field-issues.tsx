import type { FieldIssue } from "@/lib/validation-errors";

/**
 * Renders per-field 422 validation issues as a bulleted list beneath a form's
 * error banner (see `describeApiError`). Returns null when there are none, so
 * callers can drop it in unconditionally:
 *
 *   <AlertDescription>
 *     <p>{error}</p>
 *     <FieldIssueList issues={fieldIssues} />
 *   </AlertDescription>
 */
export function FieldIssueList({ issues }: { issues: FieldIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
      {issues.map((issue, i) => (
        <li key={`${issue.path}-${i}`}>
          <span className="font-medium">{issue.label}</span>
          {": "}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
