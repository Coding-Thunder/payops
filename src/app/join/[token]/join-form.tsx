"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { api, ApiClientError } from "@/lib/api-client";

interface JoinFormProps {
  token: string;
  email: string;
  defaultName: string;
}

export function JoinForm({ token, email, defaultName }: JoinFormProps) {
  const [name, setName] = useState(defaultName);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/team/activate", {
        token,
        name: name.trim() || undefined,
        password,
      });
      // Hard navigation so the new session cookie is picked up server-side.
      window.location.assign("/app/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't accept the invitation. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="join-email">Email</Label>
        <Input id="join-email" value={email} readOnly disabled />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="join-name">Your name</Label>
        <Input
          id="join-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoComplete="name"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="join-password">Create a password</Label>
        <Input
          id="join-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={200}
          placeholder="At least 10 characters"
          autoComplete="new-password"
        />
        <p className="text-[11px] text-muted-foreground">
          At least 10 characters, with an uppercase letter, a lowercase letter,
          and a number.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <LoadingButton
        type="submit"
        className="w-full"
        loading={submitting}
        loadingText="Joining"
      >
        Accept invitation
      </LoadingButton>
    </form>
  );
}

/** Shown when the invitee is already signed into another account — they must
 *  sign out to accept the invitation as the invited email. */
export function JoinSignedIn({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.post("/api/auth/logout");
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        You&apos;re signed in as{" "}
        <strong className="text-foreground">{email}</strong>. Sign out to accept
        this invitation with the invited email.
      </p>
      <LoadingButton
        onClick={signOut}
        loading={busy}
        loadingText="Signing out"
        variant="outline"
      >
        Sign out
      </LoadingButton>
    </div>
  );
}
