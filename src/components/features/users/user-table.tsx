"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/common/empty-state";
import {
  RecordStateBadge,
  UserRoleBadge,
} from "@/components/common/status-badges";
import {
  RecordState,
  UserRole,
  type UserRole as UserRoleT,
} from "@/lib/constants/enums";
import { formatDate, formatRelative } from "@/lib/format";
import type { PublicUser } from "@/types";

import { EditUserDialog } from "./edit-user-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";

interface UserTableProps {
  items: PublicUser[];
  currentUserId: string;
  currentUserRole: UserRoleT;
}

export function UserTable({
  items,
  currentUserId,
  currentUserRole,
}: UserTableProps) {
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [resetting, setResetting] = useState<PublicUser | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        title="No team members yet"
        description="Add admins and staff to create payable orders."
      />
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Last login</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="w-[40px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((u) => {
              const isSelf = u.id === currentUserId;
              const canManageThis =
                currentUserRole === UserRole.SUPER_ADMIN ||
                u.role !== UserRole.SUPER_ADMIN;
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="font-medium text-sm">{u.name}</div>
                    <div className="md:hidden text-xs text-muted-foreground">
                      {u.email}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    <UserRoleBadge role={u.role} />
                  </TableCell>
                  <TableCell>
                    <RecordStateBadge state={u.status} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                    {u.lastLoginAt ? formatRelative(u.lastLoginAt) : "Never"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                    {formatDate(u.createdAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontalIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={!canManageThis}
                          onClick={() => setEditing(u)}
                        >
                          Edit user
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canManageThis}
                          onClick={() => setResetting(u)}
                        >
                          Reset password
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {isSelf ? (
                          <DropdownMenuItem disabled>
                            That&apos;s you
                          </DropdownMenuItem>
                        ) : null}
                        {u.status === RecordState.ACTIVE ? (
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={!canManageThis || isSelf}
                            onClick={() => setEditing({ ...u })}
                          >
                            Disable account
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing ? (
        <EditUserDialog
          user={editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          actorRole={currentUserRole}
          isSelf={editing.id === currentUserId}
        />
      ) : null}

      {resetting ? (
        <ResetPasswordDialog
          user={resetting}
          open={!!resetting}
          onOpenChange={(o) => !o && setResetting(null)}
        />
      ) : null}
    </>
  );
}
