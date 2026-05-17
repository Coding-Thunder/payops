"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import {
  RecordStateLabel,
  UserRoleLabel,
} from "@/lib/constants/labels";
import {
  RECORD_STATES,
  RecordState,
  UserRole,
  USER_ROLES,
} from "@/lib/constants/enums";
import {
  updateUserSchema,
  type UpdateUserInput,
} from "@/lib/validation";
import type { PublicUser } from "@/types";

interface EditUserDialogProps {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorRole: UserRole;
  isSelf: boolean;
}

export function EditUserDialog({
  user,
  open,
  onOpenChange,
  actorRole,
  isSelf,
}: EditUserDialogProps) {
  const router = useRouter();
  const form = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    defaultValues: {
      name: user.name,
      role: user.role,
      status: user.status,
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const canSetSuperAdmin = actorRole === UserRole.SUPER_ADMIN;

  async function onSubmit(values: UpdateUserInput) {
    try {
      await api.patch<PublicUser>(`/api/admin/users/${user.id}`, values);
      toast.success("User updated");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not update user";
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {user.name}</DialogTitle>
          <DialogDescription>
            Update profile, role, or status. Role and status changes are
            recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={isSubmitting} />
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
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting || isSelf}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {USER_ROLES.filter(
                        (r) =>
                          r !== UserRole.SUPER_ADMIN || canSetSuperAdmin,
                      ).map((r) => (
                        <SelectItem key={r} value={r}>
                          {UserRoleLabel[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting || isSelf}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {RECORD_STATES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {RecordStateLabel[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : null}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
