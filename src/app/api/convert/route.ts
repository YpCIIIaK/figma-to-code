import { NextRequest, NextResponse } from "next/server";
import { generate, GenerateInputError } from "@/lib/figma/generate";

export const runtime = "nodejs";

// The Figma plugin UI runs in a sandboxed (cross-origin) iframe and calls this
// route directly to render code + preview without opening the web app. The
// plugin can also run generate() from its own bundle, with no server at all.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * POST /api/convert
 * body: GenerateBody (see src/lib/figma/generate.ts)
 * Returns generated code for every target: { react, html, vue, cssJsx, cssCss }.
 */
export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(generate(await req.json()), { headers: CORS });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: err.message ?? "Ошибка конвертации" },
      { status: err instanceof GenerateInputError ? 400 : 500, headers: CORS },
    );
  }
}
