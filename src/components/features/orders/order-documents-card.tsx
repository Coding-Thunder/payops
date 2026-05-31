"use client";

import { useEffect, useState } from "react";
import {
  DownloadIcon,
  FileTextIcon,
  PlusIcon,
  ReceiptIcon,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingButton } from "@/components/ui/loading-button";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";

/**
 * Documents card on the order detail page.
 *
 * Lists invoices / receipts already issued for this order, with a
 * one-click "Open" affordance that opens the rendered HTML in a new
 * tab — the browser's print dialog handles "Save as PDF". Admins
 * with DOCUMENT_ISSUE see two CTAs (Issue invoice, Issue receipt);
 * the receipt CTA is disabled until the order is paid (mirroring
 * the service-layer guard).
 *
 * No optimistic UI: we re-fetch the list after issuing so the new
 * number + timestamp come straight from the server.
 */

type DocumentKind = "INVOICE" | "RECEIPT";

interface DocumentDTO {
  id: string;
  kind: DocumentKind;
  number: string;
  issuedAt: string;
  snapshot: {
    pricing: {
      grandTotal: number;
      currency: string;
    };
  };
}

interface OrderDocumentsCardProps {
  orderId: string;
  canIssue: boolean;
  /** Paid orders allow receipts; non-paid still allow invoices. */
  isPaid: boolean;
}

export function OrderDocumentsCard({
  orderId,
  canIssue,
  isPaid,
}: OrderDocumentsCardProps) {
  const [docs, setDocs] = useState<DocumentDTO[] | null>(null);
  const [issuing, setIssuing] = useState<DocumentKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<{ items: DocumentDTO[] }>(
          `/api/orders/${orderId}/documents`,
        );
        if (!cancelled) setDocs(res.items);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError ? err.message : "Couldn't load",
          );
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function issue(kind: DocumentKind) {
    setIssuing(kind);
    setError(null);
    try {
      const res = await api.post<{ document: DocumentDTO }>(
        `/api/orders/${orderId}/documents`,
        { kind },
      );
      setDocs((prev) => [res.document, ...(prev ?? [])]);
      toast.success(`${labelFor(kind)} ${res.document.number} issued`);
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Issue failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setIssuing(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileTextIcon className="size-4 text-muted-foreground" />
          Documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {docs === null ? (
          <p className="text-[12.5px] text-muted-foreground">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground italic">
            No invoices or receipts issued yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 p-2.5"
              >
                {d.kind === "RECEIPT" ? (
                  <ReceiptIcon className="size-3.5 text-emerald-600 shrink-0" />
                ) : (
                  <FileTextIcon className="size-3.5 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px]">{d.number}</span>
                    <Badge variant="outline" className="text-[10.5px]">
                      {labelFor(d.kind)}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(d.issuedAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                >
                  <a
                    href={`/api/documents/${d.id}/render`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <DownloadIcon className="size-3.5" />
                    Open
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {canIssue ? (
          <div className="flex gap-2 pt-1">
            <LoadingButton
              size="sm"
              variant="outline"
              onClick={() => issue("INVOICE")}
              loading={issuing === "INVOICE"}
              loadingText="Issuing"
              className="gap-1.5"
              disabled={issuing !== null}
            >
              <PlusIcon className="size-3.5" />
              Issue invoice
            </LoadingButton>
            <LoadingButton
              size="sm"
              variant="outline"
              onClick={() => issue("RECEIPT")}
              loading={issuing === "RECEIPT"}
              loadingText="Issuing"
              className="gap-1.5"
              disabled={issuing !== null || !isPaid}
              title={!isPaid ? "Order must be paid before issuing a receipt" : undefined}
            >
              <PlusIcon className="size-3.5" />
              Issue receipt
            </LoadingButton>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function labelFor(kind: DocumentKind): string {
  return kind === "INVOICE" ? "Invoice" : "Receipt";
}
