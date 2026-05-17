"use client";

import * as React from "react";
import {
  CreditCardIcon,
  FilePlus2Icon,
  FileTextIcon,
  ShieldAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useWorkspaceStore } from "../store";
import {
  WorkspaceTabType,
  type WorkspaceTab,
} from "../types";

const TAB_ICONS: Record<WorkspaceTabType, LucideIcon> = {
  [WorkspaceTabType.CREATE_ORDER]: FilePlus2Icon,
  [WorkspaceTabType.DRAFT_ORDER]: FileTextIcon,
  [WorkspaceTabType.ORDER_DETAILS]: CreditCardIcon,
  [WorkspaceTabType.PAYMENT_REVIEW]: ShieldAlertIcon,
};

/**
 * Top-of-content tab strip. Rendered between the topbar and the page body.
 * Hidden when the workspace is empty so the chrome doesn't take vertical
 * space on pages that don't participate (settings, analytics, etc.).
 */
export function WorkspaceTabBar({
  onActivate,
  onClose,
}: {
  onActivate: (tab: WorkspaceTab) => void;
  onClose: (tab: WorkspaceTab) => void;
}) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const activeTabRef = React.useRef<HTMLDivElement>(null);

  // Keep the active tab in view as the strip overflows.
  React.useEffect(() => {
    if (!activeTabRef.current || !scrollRef.current) return;
    const tab = activeTabRef.current;
    const container = scrollRef.current;
    const tabLeft = tab.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;
    if (tabLeft < viewportLeft) {
      container.scrollTo({ left: tabLeft - 8, behavior: "smooth" });
    } else if (tabRight > viewportRight) {
      container.scrollTo({
        left: tabRight - container.clientWidth + 8,
        behavior: "smooth",
      });
    }
  }, [activeTabId]);

  if (tabs.length === 0) return null;

  return (
    <div
      className={cn(
        "sticky top-14 z-20 flex h-9 items-stretch gap-px",
        "border-b border-border bg-background/90 backdrop-blur-md",
      )}
      role="tablist"
      aria-label="Workspace tabs"
    >
      <div
        ref={scrollRef}
        className={cn(
          "flex flex-1 items-stretch overflow-x-auto scrollbar-thin",
          "scroll-smooth",
        )}
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            activeRef={tab.id === activeTabId ? activeTabRef : undefined}
            onActivate={() => onActivate(tab)}
            onClose={() => onClose(tab)}
          />
        ))}
      </div>
      <OverflowMenu tabs={tabs} activeTabId={activeTabId} onActivate={onActivate} />
    </div>
  );
}

interface TabItemProps {
  tab: WorkspaceTab;
  active: boolean;
  activeRef?: React.RefObject<HTMLDivElement | null>;
  onActivate: () => void;
  onClose: () => void;
}

function TabItem({ tab, active, activeRef, onActivate, onClose }: TabItemProps) {
  const Icon = TAB_ICONS[tab.type];

  function onMouseDown(e: React.MouseEvent) {
    // Middle click = close (VSCode/Chrome muscle memory).
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={activeRef}
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          data-active={active || undefined}
          onClick={onActivate}
          onMouseDown={onMouseDown}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onActivate();
            }
          }}
          className={cn(
            "group relative flex max-w-[16rem] shrink-0 cursor-pointer items-center gap-1.5",
            "border-r border-border px-2.5 text-[12.5px] leading-none",
            "select-none transition-colors",
            active
              ? "bg-card text-foreground"
              : "bg-background text-muted-foreground hover:bg-surface-1 hover:text-foreground",
          )}
        >
          {active ? (
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-[2px] rounded-b-full bg-primary"
            />
          ) : null}
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              active
                ? "text-foreground"
                : "text-muted-foreground/70 group-hover:text-foreground",
            )}
          />
          <span className="truncate tracking-tight">{tab.label}</span>
          {tab.dirty ? (
            <span
              aria-label="Unsaved changes"
              className="ml-0.5 inline-block size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
          <button
            type="button"
            aria-label={`Close ${tab.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={cn(
              "ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm",
              "text-muted-foreground opacity-0 transition-opacity",
              "hover:bg-muted hover:text-foreground",
              "group-hover:opacity-100 group-focus-within:opacity-100",
              active && "opacity-80",
            )}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      {tab.subtitle ? (
        <TooltipContent side="bottom">{tab.subtitle}</TooltipContent>
      ) : null}
    </Tooltip>
  );
}

function OverflowMenu({
  tabs,
  activeTabId,
  onActivate,
}: {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivate: (tab: WorkspaceTab) => void;
}) {
  const closeAll = useWorkspaceStore((s) => s.closeAll);
  const reopen = useWorkspaceStore((s) => s.reopenLastClosed);
  const closedStack = useWorkspaceStore((s) => s.closedStack);

  if (tabs.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="m-0.5 shrink-0"
          aria-label="All open tabs"
        >
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {tabs.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onClick={() => onActivate(t)}
            className={t.id === activeTabId ? "bg-surface-1" : undefined}
          >
            <TabIconFor type={t.type} />
            <span className="flex-1 truncate">{t.label}</span>
            {t.dirty ? (
              <span className="ml-1 size-1.5 shrink-0 rounded-full bg-warning" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={closedStack.length === 0}
          onClick={() => reopen()}
        >
          Reopen last closed tab
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => closeAll()}
        >
          Close all (keep dirty)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabIconFor({ type }: { type: WorkspaceTabType }) {
  const Icon = TAB_ICONS[type];
  return <Icon className="size-3.5" />;
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      {...props}
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
