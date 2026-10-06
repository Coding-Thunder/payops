import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";

import type { ItineraryIssue } from "@/lib/flight-itinerary";
import { cn } from "@/lib/utils";

/**
 * Live itinerary problems, right where they apply. Errors (red) block
 * saving — the schema raises the same ones; warnings (amber) are usually
 * typos but can be legitimate, so they never do. The copy is
 * `itineraryIssues`' own, verbatim.
 */
export function ItineraryIssueList({
  issues,
  className,
}: {
  issues: readonly ItineraryIssue[];
  className?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5", className)}>
      {issues.map((issue) => {
        const isError = issue.severity === "error";
        const Icon = isError ? CircleAlertIcon : TriangleAlertIcon;
        return (
          <li
            key={`${issue.path.join(".")}:${issue.message}`}
            className={cn(
              "flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs leading-relaxed",
              isError
                ? "bg-destructive-soft font-medium text-destructive"
                : "bg-warning-soft text-warning-foreground",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                isError ? "text-destructive" : "text-warning",
              )}
              aria-hidden
            />
            <span className="min-w-0 break-words">
              <span className="sr-only">{isError ? "Error: " : "Warning: "}</span>
              {issue.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
