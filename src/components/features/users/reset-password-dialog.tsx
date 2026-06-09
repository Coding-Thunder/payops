"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRoundIcon } from "lucide-react";

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/password-input";
import { toast } from "@/components/ui/sonner";
import { FormDialog } from "@/components/common/form-dialog";
import { api, ApiClientError } from "@/lib/api-client";
import {
  resetUserPasswordSchema,
  type ResetUserPasswordInput,
} from "@/lib/validation";
import type { PublicUser } from "@/types";

interface ResetPasswordDialogProps {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
}: ResetPasswordDialogProps) {
  const form = useForm<ResetUserPasswordInput>({
    resolver: zodResolver(resetUserPasswordSchema),
    defaultValues: { newPassword: "" },
    mode: "onTouched",
  });

  async function onSubmit(values: ResetUserPasswordInput) {
    try {
      await api.post(`/api/admin/users/${user.id}/reset-password`, values);
      toast.success("Password reset. Share it securely with the user.");
      form.reset();
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not reset password";
      toast.error(message);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) form.reset();
      }}
      title={`Reset password for ${user.name}`}
      description="Generate a temporary password and share it with the user through a secure channel."
      icon={<KeyRoundIcon />}
      tone="warning"
      submitLabel="Reset password"
      onSubmit={async (e) => {
        await form.handleSubmit(onSubmit)(e);
      }}
    >
      <Form {...form}>
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Temporary password</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="off" {...field} />
              </FormControl>
              <FormDescription>
                Must include upper, lower, and a number; minimum 10
                characters. The user can change it after logging in.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>
    </FormDialog>
  );
}
