"use client";

import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Global client search. Enter (or clicking a result once the ⌘K palette is
 * wired) opens the matching Client Profile. Today it routes to the Clients
 * list filtered by the query, which already matches on name / email / phone
 * / company; invoice-number search + inline results land in the next pass.
 */
export function DashboardSearch() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    router.push(
      query ? `/app/customers?q=${encodeURIComponent(query)}` : "/app/customers",
    );
  }

  return (
    <form onSubmit={submit} className="relative">
      <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search clients, orders, invoices, payments, emails or phone numbers…"
        aria-label="Search clients"
        className="h-12 w-full rounded-xl border border-border bg-card pl-11 pr-16 text-[14px] text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
      />
      <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-surface-1 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:block">
        ⌘ K
      </kbd>
    </form>
  );
}
