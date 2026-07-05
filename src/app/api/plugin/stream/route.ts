import { subscribe, getLatest } from "@/lib/plugin/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/plugin/stream
 * Server-Sent Events: pushes each design payload the plugin sends, plus the
 * last one immediately on connect (so a freshly opened tab catches up).
 */
export async function GET() {
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (data: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        } catch {
          /* stream closed */
        }
      };

      // Flush a first byte right away so headers are sent and the client's
      // EventSource fires `open` (some dev servers buffer until first chunk).
      controller.enqueue(enc.encode(`: connected\n\n`));

      const last = getLatest();
      if (last) send(last);

      const unsub = subscribe(send);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          /* stream closed */
        }
      }, 25000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsub();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
