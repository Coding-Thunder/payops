"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { api, ApiClientError } from "@/lib/api-client";

interface ActivateFormProps {
  token: string;
  email: string;
  defaultName: string;
  turnstileSiteKey: string | null;
}

export function ActivateForm({
  token,
  email,
  defaultName,
  turnstileSiteKey,
}: ActivateFormProps) {
  const [name, setName] = useState(defaultName);
  const [password, setPassword] = useState("");
  const [cfToken, setCfToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresToken = Boolean(turnstileSiteKey);
  const ready = !requiresToken || Boolean(cfToken);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge first.");
      return;
    }
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/beta/activate", {
        token,
        name: name.trim() || undefined,
        password,
        cfToken: cfToken ?? undefined,
      });
      // Hard navigation so the new session cookie is picked up server-side.
      window.location.assign("/app/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't activate your account. Please try again.",
      );
      setCfToken(null);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ac-email">Email</Label>
        <Input id="ac-email" value={email} readOnly disabled />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ac-name">Your name</Label>
        <Input
          id="ac-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoComplete="name"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ac-password">Create a password</Label>
        <Input
          id="ac-password"
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

      {requiresToken ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          onVerify={(t) => setCfToken(t)}
          onExpire={() => setCfToken(null)}
          onError={() => setCfToken(null)}
        />
      ) : null}

      <LoadingButton
        type="submit"
        className="w-full"
        loading={submitting}
        loadingText="Activating"
        disabled={!ready}
      >
        Activate account
      </LoadingButton>
    </form>
  );
}
