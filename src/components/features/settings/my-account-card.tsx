"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LogOutIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/sonner";
import { Section } from "@/components/common/section";
import { api, ApiClientError } from "@/lib/api-client";
import { WorkspaceRoleLabel } from "@/lib/constants/labels";
import type { WorkspaceRole } from "@/lib/constants/permissions";
import { formatDate, formatRelative } from "@/lib/format";
import { updateAccountSchema, type UpdateAccountInput } from "@/lib/validation";

interface MyAccountCardProps {
  name: string;
  email: string;
  workspaceRole: WorkspaceRole;
  lastLoginAt: string | null;
  createdAt: string | null;
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export function MyAccountCard({
  name,
  email,
  workspaceRole,
  lastLoginAt,
  createdAt,
}: MyAccountCardProps) {
  const router = useRouter();
  const form = useForm<UpdateAccountInput>({
    resolver: zodResolver(updateAccountSchema),
    defaultValues: { name },
    mode: "onTouched",
  });
  const isSubmitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;

  async function onSubmit(values: UpdateAccountInput) {
    try {
      await api.patch("/api/account", values);
      toast.success("Account updated");
      form.reset(values);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not save changes";
      toast.error(message);
    }
  }

  async function onSignOut() {
    try {
      await api.post("/api/auth/logout");
      router.push("/login");
      router.refresh();
    } catch {
      toast.error("Could not sign out");
    }
  }

  return (
    <Section
      title="My Account"
      description="Your identity in this workspace. Email and role are managed elsewhere."
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <div className="flex gap-2">
                  <FormControl>
                    <Input disabled={isSubmitting} {...field} />
                  </FormControl>
                  <LoadingButton
                    type="submit"
                    size="sm"
                    disabled={!isDirty}
                    loading={isSubmitting}
                    loadingText="Saving"
                  >
                    Save
                  </LoadingButton>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>

      <div className="mt-4 divide-y divide-border border-t border-border">
        <ReadonlyRow label="Email" value={email} />
        <ReadonlyRow label="Role" value={WorkspaceRoleLabel[workspaceRole]} />
        <ReadonlyRow
          label="Last sign-in"
          value={lastLoginAt ? formatRelative(lastLoginAt) : "—"}
        />
        <ReadonlyRow
          label="Member since"
          value={createdAt ? formatDate(createdAt) : "—"}
        />
        <div className="flex items-center justify-between gap-3 py-2">
          <span className="text-[12.5px] text-muted-foreground">Password</span>
          <span className="text-[12.5px] text-muted-foreground">
            Managed by your sign-in provider
          </span>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onSignOut}>
          <LogOutIcon className="size-3.5" /> Sign out
        </Button>
      </div>
    </Section>
  );
}
