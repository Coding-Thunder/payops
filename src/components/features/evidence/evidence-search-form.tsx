"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { SearchIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { api, ApiClientError } from "@/lib/api-client";
import {
  OrderEvidenceEventLabel,
} from "@/lib/constants/labels";
import { formatDateTime } from "@/lib/format";
import type { OrderEvidenceSearchResultDTO } from "@/types";

const FIELDS = [
  { value: "auto", label: "Auto-detect" },
  { value: "orderNumber", label: "Order number" },
  { value: "customerEmail", label: "Customer email" },
  { value: "paymentSessionId", label: "Payment session id" },
  { value: "paymentIntentId", label: "Payment intent id" },
  { value: "transactionId", label: "Transaction id" },
  { value: "gatewayEventId", label: "Gateway event id" },
  { value: "consentTokenHash", label: "Consent token (raw or hashed)" },
  { value: "signatureName", label: "Signed name" },
  { value: "messageId", label: "Email message id" },
] as const;

/**
 * Cross-order evidence search. Given any reference quoted in a
 * chargeback letter (transaction id, customer email, signed name,
 * etc.), the form resolves it back to the originating order and
 * surfaces a deep link into the evidence page.
 */
export function EvidenceSearchForm() {
  const [q, setQ] = useState("");
  const [field, setField] = useState<string>("auto");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<OrderEvidenceSearchResultDTO[] | null>(
    null,
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, field });
      const data = await api.get<{
        results: OrderEvidenceSearchResultDTO[];
      }>(`/api/admin/evidence/search?${params.toString()}`);
      setResults(data.results);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Search failed";
      setError(msg);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence search</CardTitle>
        <CardDescription>
          Find the originating order from any reference quoted in a
          dispute letter, transaction id, customer email, gateway event
          id, signed name. Raw consent tokens are hashed before lookup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={onSubmit}
          className="grid gap-3 sm:grid-cols-[1fr_220px_auto]"
        >
          <div className="space-y-1">
            <Label htmlFor="evidence-search-q">Query</Label>
            <Input
              id="evidence-search-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="cs_test_… / customer@example.com / pi_…"
              required
              minLength={1}
              maxLength={254}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="evidence-search-field">Field</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger id="evidence-search-field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELDS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={loading || !q.trim()}>
              <SearchIcon className="size-3.5" />
              {loading ? "Searching…" : "Search"}
            </Button>
          </div>
        </form>

        {error ? (
          <p className="text-[12.5px] text-destructive">{error}</p>
        ) : null}

        {results !== null ? (
          results.length === 0 ? (
            <EmptyState
              title="No matches"
              description="No evidence event matches that value. Try a different field or paste a different reference."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Matched on</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Occurred</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.eventId}>
                    <TableCell className="font-mono text-[12px]">
                      {r.orderNumber}
                    </TableCell>
                    <TableCell>{r.customerEmail ?? "-"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{r.matchedField}</Badge>
                    </TableCell>
                    <TableCell>
                      {OrderEvidenceEventLabel[r.eventType] ?? r.eventType}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-[11.5px]">
                      {formatDateTime(r.occurredAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/app/orders/${r.orderId}/evidence`}>
                          Open chain
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
