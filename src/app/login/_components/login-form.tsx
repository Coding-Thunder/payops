"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, ApiClientError } from "@/lib/api-client";
import { loginSchema, type LoginInput } from "@/lib/validation";
import type { SessionUser } from "@/types";

interface LoginFormProps {
  nextPath?: string;
  /** Cloudflare Turnstile site key. When null the widget is omitted
   *  entirely and the form posts without a `cfToken` — server-side
   *  verification is also disabled in that case, so dev keeps working. */
  turnstileSiteKey?: string | null;
}

export function LoginForm({ nextPath, turnstileSiteKey }: LoginFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const requiresToken = Boolean(turnstileSiteKey);
  const canSubmit = !requiresToken || Boolean(cfToken);

  async function onSubmit(values: LoginInput) {
    setError(null);
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge before signing in.");
      return;
    }
    try {
      await api.post<SessionUser>("/api/auth/login", {
        ...values,
        cfToken: cfToken ?? undefined,
      });
      router.replace(safeNext(nextPath));
      router.refresh();
    } catch (err) {
      // Reset the Turnstile widget so the user can retry; CF tokens are
      // single-use and become invalid after the first verification call.
      setCfToken(null);
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Login failed</AlertTitle>
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

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
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
          loadingText="Signing in"
          disabled={!canSubmit}
        >
          Sign in
        </LoadingButton>
      </form>
    </Form>
  );
}

function safeNext(value?: string): string {
  if (!value) return "/app/dashboard";
  if (!value.startsWith("/")) return "/app/dashboard";
  if (value.startsWith("//")) return "/app/dashboard";
  if (value.startsWith("/login")) return "/app/dashboard";
  return value;
}
