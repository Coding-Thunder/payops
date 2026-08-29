"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserCogIcon } from "lucide-react";

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
import { FormDialog } from "@/components/common/form-dialog";
import { api, ApiClientError } from "@/lib/api-client";
import { RecordStateLabel, UserRoleLabel } from "@/lib/constants/labels";
import {
  RECORD_STATES,
  UserRole,
  USER_ROLES,
} from "@/lib/constants/enums";
import {
  updateUserSchema,
  type UpdateUserInput,
} from "@/lib/validation";
import type { PublicUser } from "@/types";

import {
  OrganizationAccessField,
  roleHasGlobalOrgAccess,
  useOrganizationOptions,
} from "./organization-access-field";

/** GET /api/admin/users/[id] returns the public user plus the ids of the
 *  organizations they hold an ACTIVE membership of. */
type UserWithMemberships = PublicUser & { organizationIds?: string[] };

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
      organizationIds: [],
    },
    mode: "onTouched",
  });

  const canSetSuperAdmin = actorRole === UserRole.SUPER_ADMIN;

  const {
    organizations,
    loading: orgsLoading,
    ready: orgsReady,
  } = useOrganizationOptions(open);
  const selectedRole = form.watch("role");
  const isGlobalRole = roleHasGlobalOrgAccess(selectedRole);
  const orgsInPlay = orgsReady && organizations.length > 0;

  // The row that opened this dialog comes from the users LIST, which does
  // not carry memberships — they are read from the detail endpoint so the
  // boxes start pre-checked with what the user actually holds today.
  // `null` until the read lands — which is also how "not loaded yet" is
  // told apart from "loaded, and holds nothing".
  const [loadedOrgIds, setLoadedOrgIds] = useState<string[] | null>(null);
  const [membershipsError, setMembershipsError] = useState(false);
  const { setValue } = form;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get<UserWithMemberships>(`/api/admin/users/${user.id}`)
      .then((res) => {
        if (cancelled) return;
        const ids = res?.organizationIds ?? [];
        setLoadedOrgIds(ids);
        setValue("organizationIds", ids, { shouldDirty: false });
      })
      .catch(() => {
        if (!cancelled) setMembershipsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user.id, setValue]);

  const membershipsReady = loadedOrgIds !== null;
  const membershipsLoading = open && !membershipsReady && !membershipsError;

  // Whether this submit is allowed to carry a membership list at all.
  // Sending one built from an unknown starting point would REVOKE whatever
  // failed to load, so a failed read means the key is omitted and the
  // user's organizations are left exactly as they are.
  const canEditOrganizations =
    orgsInPlay && !isGlobalRole && !isSelf && membershipsReady;

  async function onSubmit(values: UpdateUserInput) {
    const { organizationIds, ...rest } = values;

    let payload: UpdateUserInput = rest;
    if (canEditOrganizations) {
      if (!organizationIds || organizationIds.length === 0) {
        form.setError("organizationIds", {
          type: "manual",
          message:
            "Select at least one organization — removing them all would leave this user with no access.",
        });
        return;
      }
      payload = { ...rest, organizationIds };
    }

    try {
      await api.patch<PublicUser>(`/api/admin/users/${user.id}`, payload);
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${user.name}`}
      description={
        isSelf
          ? "You can rename yourself but cannot change your own role or status."
          : "Role or status changes are recorded in the audit log."
      }
      icon={<UserCogIcon />}
      tone="info"
      submitLabel="Save changes"
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
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSelf}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {USER_ROLES.filter(
                        (r) => r !== UserRole.SUPER_ADMIN || canSetSuperAdmin,
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
                    disabled={isSelf}
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
          </div>

          {orgsLoading || membershipsLoading || organizations.length > 0 ? (
            <FormField
              control={form.control}
              name="organizationIds"
              render={({ field }) => (
                <OrganizationAccessField
                  organizations={organizations}
                  value={field.value ?? []}
                  onChange={field.onChange}
                  role={selectedRole}
                  loading={orgsLoading || membershipsLoading}
                  disabled={isSelf || (!membershipsReady && !isGlobalRole)}
                  note={
                    membershipsError && !isGlobalRole ? (
                      <p className="text-xs text-muted-foreground">
                        Could not load this user&apos;s current organizations,
                        so they are left unchanged by this save. Close and
                        reopen to try again.
                      </p>
                    ) : null
                  }
                />
              )}
            />
          ) : null}
        </div>
      </Form>
    </FormDialog>
  );
}
