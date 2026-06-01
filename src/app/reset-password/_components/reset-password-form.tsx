"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { api, ApiClientError } from "@/lib/api-client";
import {
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/lib/validation";

interface ResetPasswordFormProps {
  /** HMAC-signed token from the URL, passed to the server so it can
   *  verify + look up the user without a separate session. */
  token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, newPassword: "" },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: ResetPasswordInput) {
    setError(null);
    try {
      await api.post("/api/auth/reset-password", values);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Something went wrong. Please request a new link.");
      }
    }
  }

  if (done) {
    return (
      <Alert>
        <AlertTitle>Password updated</AlertTitle>
        <AlertDescription>
          You can now <a href="/login" className="underline">sign in</a> with
          your new password.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Form {...form}>
      <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t reset your password</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
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
                10+ characters, one uppercase, one lowercase, one digit.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LoadingButton
          type="submit"
          className="w-full"
          loading={isSubmitting}
          loadingText="Updating"
        >
          Set new password
        </LoadingButton>
      </form>
    </Form>
  );
}
