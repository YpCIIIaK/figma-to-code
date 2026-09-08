import { NextRequest, NextResponse } from "next/server";
import { readIndex, saveFaces, buildCss } from "@/lib/fonts-store";
import { faceId, guessMeta } from "@/lib/fonts";

export const runtime = "nodejs";

// The Figma plugin UI is a cross-origin sandbox; it uploads and reads the same
// font set as the web app.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/fonts            → { faces: StoredFace[] }  (metadata only, small)
 * GET /api/fonts?css=1&families=Inter,Gilroy
 *                           → { css }  @font-face with embedded bytes
 */
export async function GET(req: NextRequest) {
  const faces = await readIndex();
  const sp = req.nextUrl.searchParams;
  if (sp.get("css")) {
    const families = (sp.get("families") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return NextResponse.json({ css: await buildCss(faces, families) }, { headers: CORS });
  }
  return NextResponse.json({ faces }, { headers: CORS });
}

const EXT_FORMAT: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/**
 * POST /api/fonts
 * body: { faces: [...] }              — replaces the whole set (web panel)
 *   or: { add: [{ fileName, base64 }] } — appends files, guessing family/weight
 *                                         (the plugin, which has no editor UI)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (Array.isArray(body?.add)) {
      const current = await readIndex();
      type Incoming = Parameters<typeof saveFaces>[0][number];
      const merged = new Map<string, Incoming>(current.map((f) => [f.id, f as Incoming]));
      const skipped: string[] = [];
      for (const item of body.add) {
        const ext = String(item.fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
        const format = EXT_FORMAT[ext];
        if (!format || !item.base64) {
          skipped.push(item.fileName ?? "?");
          continue;
        }
        const { family, weight, style } = guessMeta(item.fileName);
        const id = faceId(family, weight, style);
        merged.set(id, {
          id,
          fileName: item.fileName,
          family,
          weight,
          style,
          format,
          base64: item.base64,
        });
      }
      const faces = await saveFaces([...merged.values()]);
      return NextResponse.json({ faces, skipped }, { headers: CORS });
    }

    if (!Array.isArray(body?.faces)) {
      return NextResponse.json(
        { error: "faces или add обязателен" },
        { status: 400, headers: CORS },
      );
    }
    const faces = await saveFaces(body.faces);
    return NextResponse.json({ faces }, { headers: CORS });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: err.message ?? "Не удалось сохранить шрифты" },
      { status: 500, headers: CORS },
    );
  }
}
