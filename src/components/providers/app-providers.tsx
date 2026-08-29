"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { NotificationSoundProvider } from "@/components/providers/notification-sound-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      {/* Above the organization layer on purpose: the sound preference is
          global to the console, so an organization switch must never unmount
          it or reset it. */}
      <NotificationSoundProvider>
      <TooltipProvider delayDuration={120}>
        {children}
        <Toaster />
      </TooltipProvider>
      </NotificationSoundProvider>
    </QueryClientProvider>
  );
}
