import { NextRequest } from "next/server";
import { publish } from "@/lib/plugin/bus";

export const runtime = "nodejs";

// The plugin UI runs in a sandboxed (cross-origin) iframe, so allow CORS.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * POST /api/plugin/ingest
 * body: raw JSON { fileName, node, assets:{svg,png}, preview }
 * Relays the payload to any connected app tab via SSE.
 */
export async function POST(req: NextRequest) {
  const text = await req.text();
  // Guard against absurd payloads (a huge selection).
  if (text.length > 25 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "payload too large" }), {
      status: 413,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  publish(text);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
