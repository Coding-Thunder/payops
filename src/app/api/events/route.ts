import { NextRequest } from "next/server";

import { logger } from "@/lib/logger";
import {
  acquireSseSlot,
  releaseSseSlot,
} from "@/server/api/security";
import { getCurrentUser } from "@/server/auth/session";
import { isEventVisibleToUser, subscribeEvents } from "@/server/events/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream.
 *
 * Memory safety on the $5 tier:
 *   - Hard caps per-user (3) and global (100) connections via
 *     `acquireSseSlot`. Excess clients get 429 + Retry-After so the
 *     browser's EventSource backs off rather than retrying immediately.
 *   - ONE shared heartbeat timer fans out `: ping` to every active
 *     controller, instead of N timers per connection. Lives in module
 *     scope so it survives across requests.
 *   - The bus subscription, slot, and any in-flight controller all
 *     unregister on `req.signal.abort` and on stream `cancel`.
 *
 * `Last-Event-ID` replay is NOT implemented in this patch, events
 * emitted during a disconnect are lost. Acceptable for now since the
 * UI also runs a polling backstop via React Query. Replay is a P1.
 */

interface ActiveClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  userId: string;
}

const activeClients = new Set<ActiveClient>();
let heartbeatTimer: NodeJS.Timeout | null = null;
const encoder = new TextEncoder();

function startHeartbeatIfNeeded() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (activeClients.size === 0) {
      clearInterval(heartbeatTimer!);
      heartbeatTimer = null;
      return;
    }
    const ping = encoder.encode(`: ping\n\n`);
    for (const client of activeClients) {
      try {
        client.controller.enqueue(ping);
      } catch {
        // Stream already torn down, let the abort/cancel handler clean
        // it up. Swallowing is safe because heartbeat is best-effort.
      }
    }
  }, 25_000);
  // Don't hold the process alive on the heartbeat alone.
  const t = heartbeatTimer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const slot = acquireSseSlot(user.id);
  if (!slot.ok) {
    logger.warn("events.slot_refused", { userId: user.id, reason: slot.reason });
    return new Response("Too many SSE connections", {
      status: 429,
      headers: { "Retry-After": "10" },
    });
  }

  let unsubscribe: (() => void) | null = null;
  let registered: ActiveClient | null = null;
  let released = false;

  const releaseAll = () => {
    if (released) return;
    released = true;
    if (registered) activeClients.delete(registered);
    unsubscribe?.();
    unsubscribe = null;
    releaseSseSlot(user.id);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      registered = { controller, userId: user.id };
      activeClients.add(registered);
      startHeartbeatIfNeeded();

      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Stream already closed, abort handler will fire.
        }
      };

      send(": connected\n\n");
      send(`retry: 5000\n\n`);

      unsubscribe = subscribeEvents((event) => {
        // Pass orgId so the bus filters cross-tenant events out of
        // this connection, Pass 5a closes the SSE bleed flagged in
        // the Phase-A audit risk #4.2.
        if (
          !isEventVisibleToUser(event, {
            userId: user.id,
            role: user.role,
            orgId: user.orgId,
          })
        ) {
          return;
        }
        send(`event: tracetxn\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const onAbort = () => {
        releaseAll();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", onAbort);
      logger.info("events.client_connected", { userId: user.id });
    },
    cancel() {
      releaseAll();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
