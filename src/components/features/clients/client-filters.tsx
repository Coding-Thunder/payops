"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { InlineSpinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sort keys mirror `CLIENT_SORTS` in the client-profile service. */
const SORTS: { value: string; label: string }[] = [
  { value: "activity", label: "Recent activity" },
  { value: "orders", label: "Most orders" },
  { value: "created", label: "Newest client" },
  { value: "name", label: "Name (A–Z)" },
];

/**
 * Search + sort toolbar for the Clients list. Writes `q` / `sort` to the
 * URL (server component re-reads them) and resets pagination on change,
 * matching the Orders filter behaviour so the two surfaces feel identical.
 */
export function ClientFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(currentQuery);
  const [lastSynced, setLastSynced] = useState(currentQuery);
  if (currentQuery !== lastSynced) {
    setLastSynced(currentQuery);
    setQuery(currentQuery);
  }

  function update(name: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    startTransition(() => router.push(`?${next.toString()}`));
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-2 md:flex-row md:items-center">
      <div className="relative flex-1 max-w-md">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => update("q", query.trim() || null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              update("q", query.trim() || null);
            }
          }}
          placeholder="Search by name, email, phone, or company"
          className="h-8 pl-8 bg-background"
        />
      </div>
      <Select
        value={params.get("sort") ?? "activity"}
        onValueChange={(v) => update("sort", v === "activity" ? null : v)}
      >
        <SelectTrigger className="w-full md:w-48">
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending ? <InlineSpinner text="Updating" className="px-2" /> : null}
    </div>
  );
}
