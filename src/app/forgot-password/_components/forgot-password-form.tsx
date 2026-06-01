"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/api-client";
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from "@/lib/validation";

interface Props {
  turnstileSiteKey?: string | null;
}

export function ForgotPasswordForm({ turnstileSiteKey }: Props) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState<string | null>(null);

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const requiresToken = Boolean(turnstileSiteKey);
  const canSubmit = !requiresToken || Boolean(cfToken);

  async function onSubmit(values: ForgotPasswordInput) {
    setError(null);
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge.");
      return;
    }
    try {
      await api.post("/api/auth/forgot-password", {
        ...values,
        cfToken: cfToken ?? undefined,
      });
      // Same UI regardless of whether the email existed, never
      // reveal account enumeration in the client either.
      setSent(true);
    } catch (err) {
      setCfToken(null);
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    }
  }

  if (sent) {
    return (
      <Alert>
        <AlertTitle>Check your inbox</AlertTitle>
        <AlertDescription>
          If an account exists for that email, we just sent a reset
          link. Click it within 30 minutes to set a new password.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Form {...form}>
      <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t send the link</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Work email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@company.com"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {requiresToken ? (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            onVerify={(token) => setCfToken(token)}
            onExpire={() => setCfToken(null)}
            onError={() => setCfToken(null)}
            className="flex justify-center"
          />
        ) : null}

        <LoadingButton
          type="submit"
          className="w-full"
          loading={isSubmitting}
          loadingText="Sending"
          disabled={!canSubmit}
        >
          Send reset link
        </LoadingButton>
      </form>
    </Form>
  );
}
