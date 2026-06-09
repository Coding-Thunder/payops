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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, ApiClientError } from "@/lib/api-client";
import { signupSchema, type SignupInput } from "@/lib/validation";

interface SignupFormProps {
  /** Cloudflare Turnstile site key. When null the widget is omitted
   *  entirely and the form posts without a `cfToken`, server-side
   *  verification also no-ops in that case, so dev keeps working. */
  turnstileSiteKey?: string | null;
}

interface SignupResponse {
  user: { id: string; name: string; email: string; role: string };
  orgId: string;
  orgSlug: string;
}

export function SignupForm({ turnstileSiteKey }: SignupFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState<string | null>(null);

  const form = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      orgName: "",
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const requiresToken = Boolean(turnstileSiteKey);
  const canSubmit = !requiresToken || Boolean(cfToken);

  async function onSubmit(values: SignupInput) {
    setError(null);
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge before continuing.");
      return;
    }
    try {
      await api.post<SignupResponse>("/api/auth/signup", {
        ...values,
        cfToken: cfToken ?? undefined,
      });
      // Cookie is set by the server; route into the app.
      router.replace("/app/dashboard");
      router.refresh();
    } catch (err) {
      // CF tokens are single-use, reset the widget so the user can retry.
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
            <AlertTitle>Couldn&apos;t create your workspace</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="orgName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Business name</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  autoComplete="organization"
                  placeholder="Acme Rentals"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Used in customer emails and on payment pages. You can
                change this later from /admin/branding.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Your name</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  autoComplete="name"
                  placeholder="Ada Lovelace"
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
                  autoComplete="new-password"
                  placeholder="At least 10 characters"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                10+ characters, with at least one uppercase, one
                lowercase, and one number.
              </FormDescription>
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
          loadingText="Creating your workspace"
          disabled={!canSubmit}
        >
          Create workspace
        </LoadingButton>
      </form>
    </Form>
  );
}
