"use client";

import * as React from "react";

import type { DomainEvent } from "@/lib/constants/events";

interface ActivityFeedState {
  events: DomainEvent[];
  push: (event: DomainEvent) => void;
  clear: () => void;
}

const ActivityFeedContext = React.createContext<ActivityFeedState | null>(null);

const MAX_EVENTS = 30;

export function ActivityFeedProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [events, setEvents] = React.useState<DomainEvent[]>([]);

  const push = React.useCallback((event: DomainEvent) => {
    setEvents((prev) => {
      if (prev.some((e) => e.id === event.id)) return prev;
      return [event, ...prev].slice(0, MAX_EVENTS);
    });
  }, []);

  const clear = React.useCallback(() => setEvents([]), []);

  const value = React.useMemo<ActivityFeedState>(
    () => ({ events, push, clear }),
    [events, push, clear],
  );

  return (
    <ActivityFeedContext.Provider value={value}>
      {children}
    </ActivityFeedContext.Provider>
  );
}

export function useActivityFeed(): ActivityFeedState {
  const ctx = React.useContext(ActivityFeedContext);
  if (!ctx) {
    throw new Error(
      "useActivityFeed must be used inside <ActivityFeedProvider>",
    );
  }
  return ctx;
}
