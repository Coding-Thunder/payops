"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon, UserPlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { FormDialog } from "@/components/common/form-dialog";
import { api, ApiClientError } from "@/lib/api-client";
import { UserRoleLabel } from "@/lib/constants/labels";
import { UserRole } from "@/lib/constants/enums";
import { createUserSchema, type CreateUserInput } from "@/lib/validation";
import type { PublicUser, SessionUser } from "@/types";

import {
  OrganizationAccessField,
  roleHasGlobalOrgAccess,
  useOrganizationOptions,
} from "./organization-access-field";

interface CreateUserDialogProps {
  actorRole: SessionUser["role"];
}

export function CreateUserDialog({ actorRole }: CreateUserDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      name: "",
      email: "",
      role: UserRole.STAFF,
      password: "",
      organizationIds: [],
    },
    mode: "onTouched",
  });

  const canCreateSuperAdmin = actorRole === UserRole.SUPER_ADMIN;

  // Options are only fetched while the dialog is open — this component is
  // mounted on the users page whether or not anyone is adding a member.
  const {
    organizations,
    loading: orgsLoading,
    ready: orgsReady,
  } = useOrganizationOptions(open);
  const selectedRole = form.watch("role");
  const isGlobalRole = roleHasGlobalOrgAccess(selectedRole);
  // A deployment with no organizations is the pre-migration world: the
  // server skips the membership requirement there, so the form must not
  // invent one.
  const orgsInPlay = orgsReady && organizations.length > 0;

  async function onSubmit(values: CreateUserInput) {
    const { organizationIds, ...rest } = values;

    // Global roles reach every organization regardless, so no list is sent
    // for them — a list would imply a restriction nothing enforces.
    let payload: CreateUserInput = rest;
    if (orgsInPlay && !isGlobalRole) {
      if (!organizationIds || organizationIds.length === 0) {
        form.setError("organizationIds", {
          type: "manual",
          message:
            "Select at least one organization — this user would otherwise be able to sign in and see nothing.",
        });
        return;
      }
      payload = { ...rest, organizationIds };
    }

    try {
      await api.post<PublicUser>("/api/admin/users", payload);
      toast.success("Team member added");
      setOpen(false);
      form.reset();
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not create user";
      toast.error(message);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon className="size-3.5" />
        Add team member
      </Button>

      <FormDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) form.reset();
        }}
        title="Add team member"
        description="Create an account that can log in to the operations console. Share the initial password through a secure channel."
        icon={<UserPlusIcon />}
        submitLabel="Create user"
        size="md"
        onSubmit={async (e) => {
          await form.handleSubmit(onSubmit)(e);
        }}
      >
        <Form {...form}>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Jane Smith"
                      autoComplete="name"
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
                      inputMode="email"
                      autoComplete="off"
                      placeholder="jane@company.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={UserRole.STAFF}>
                        {UserRoleLabel.STAFF}
                      </SelectItem>
                      <SelectItem value={UserRole.ADMIN}>
                        {UserRoleLabel.ADMIN}
                      </SelectItem>
                      {canCreateSuperAdmin ? (
                        <SelectItem value={UserRole.SUPER_ADMIN}>
                          {UserRoleLabel.SUPER_ADMIN}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {orgsLoading || organizations.length > 0 ? (
              <FormField
                control={form.control}
                name="organizationIds"
                render={({ field }) => (
                  <OrganizationAccessField
                    organizations={organizations}
                    value={field.value ?? []}
                    onChange={field.onChange}
                    role={selectedRole}
                    loading={orgsLoading}
                  />
                )}
              />
            ) : null}

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Temporary password</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>
                    At least 10 characters, including upper, lower, and a
                    number. The user can change it after first login.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </Form>
      </FormDialog>
    </>
  );
}
