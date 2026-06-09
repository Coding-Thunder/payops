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
    },
    mode: "onTouched",
  });

  const canCreateSuperAdmin = actorRole === UserRole.SUPER_ADMIN;

  async function onSubmit(values: CreateUserInput) {
    try {
      await api.post<PublicUser>("/api/admin/users", values);
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
