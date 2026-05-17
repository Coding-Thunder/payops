import { NextRequest } from "next/server";

import { logger } from "@/lib/logger";
import { getCurrentUser } from "@/server/auth/session";
import { isEventVisibleToUser, subscribeEvents } from "@/server/events/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream. The client opens an EventSource here, the
 * server pushes domain events filtered by the viewer's role/identity.
 *
 *   event: payops
 *   data: {"type":"order:paid","id":"...","payload":{...}}
 *
 * SSE was picked over websockets because:
 *   1. one-way push is exactly what we need (no client→server messages)
 *   2. no extra infra — runs in the same Next.js process as the API
 *   3. EventSource handles reconnect automatically
 *   4. survives HTTP/2 proxies (DigitalOcean App Platform, Cloudflare, etc.)
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Stream already closed by the client - safe to swallow.
        }
      };

      // Initial comment kicks off the connection through any buffering proxies.
      send(": connected\n\n");
      send(`retry: 5000\n\n`);

      unsubscribe = subscribeEvents((event) => {
        if (!isEventVisibleToUser(event, { userId: user.id, role: user.role })) {
          return;
        }
        send(`event: payops\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // 25s heartbeat keeps the stream alive past idle proxies.
      heartbeat = setInterval(() => send(`: ping\n\n`), 25_000);

      // Clean up if the client disconnects mid-stream.
      const onAbort = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", onAbort);
      logger.info("events.client_connected", { userId: user.id });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx, GCP, DO LB).
      "X-Accel-Buffering": "no",
    },
  });
}
