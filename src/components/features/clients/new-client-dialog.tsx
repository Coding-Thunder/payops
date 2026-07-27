"use client";

import { useRouter } from "next/navigation";
import { PlusIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";

interface NewClientDialogProps {
  /** Custom trigger element. Falls back to a default "New Client Record"
   *  button when omitted. */
  trigger?: React.ReactNode;
}

/**
 * The "New Client Record" flow. A deliberately small form — name, company,
 * email, phone, country, notes — that creates the Client Profile and drops
 * the user straight into it. If a client with the same email already exists
 * it opens that record instead of creating a duplicate.
 */
export function NewClientDialog({ trigger }: NewClientDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [company, setCompany] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [notes, setNotes] = React.useState("");

  function reset() {
    setName("");
    setCompany("");
    setEmail("");
    setPhone("");
    setCountry("");
    setNotes("");
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Client name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const { id, existed } = await api.post<{ id: string; existed: boolean }>(
        "/api/customers",
        {
          name: trimmedName,
          company: company.trim() || null,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          country: country.trim() || null,
          notes: notes.trim() || null,
        },
      );
      toast.success(
        existed ? "Opened existing client" : "Client record created",
      );
      setOpen(false);
      reset();
      router.push(`/app/customers/${id}`);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Couldn't create client",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className="gap-1.5">
            <PlusIcon className="size-4" />
            New Client Record
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New client record</DialogTitle>
            <DialogDescription>
              Everything you log for this client — invoices, payments, consent,
              files, notes — lives on their permanent record.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="nc-name">Client name</Label>
                <Input
                  id="nc-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder="Sarah Chen"
                  autoFocus
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-company">Company</Label>
                <Input
                  id="nc-company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  maxLength={160}
                  placeholder="Bloom Studio"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-email">Email</Label>
                <Input
                  id="nc-email"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                  placeholder="sarah@bloomstudio.co"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nc-phone">Phone</Label>
                <Input
                  id="nc-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={32}
                  placeholder="Optional"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="nc-country">Country</Label>
                <Input
                  id="nc-country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  maxLength={80}
                  placeholder="Optional"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nc-notes">Notes</Label>
              <Textarea
                id="nc-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder="Anything worth remembering about this client (optional)."
                className="resize-none"
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <LoadingButton type="submit" loading={submitting}>
              Create record
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
