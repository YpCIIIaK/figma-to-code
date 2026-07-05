import { NextRequest, NextResponse } from "next/server";
import { getImages, mapLimit, parseFigmaUrl, FigmaError } from "@/lib/figma/client";

export const runtime = "nodejs";

/**
 * POST /api/figma/assets
 * body: { token, url|fileKey, svgIds?: string[], pngIds?: string[] }
 * Returns inline SVG markup for icons and rendered PNG URLs for images.
 */
export async function POST(req: NextRequest) {
  try {
    const { token, url, fileKey: fk, svgIds = [], pngIds = [] } = await req.json();
    if (!token || (!svgIds.length && !pngIds.length)) {
      return NextResponse.json({ svg: {}, png: {} });
    }
    const fileKey = fk || parseFigmaUrl(url).fileKey;

    const svg: Record<string, string> = {};
    const png: Record<string, string> = {};

    if (svgIds.length) {
      const res = await getImages(token, fileKey, svgIds, "svg", 1);
      // Fetch the actual SVG markup so the output is self-contained.
      // These are figma-CDN URLs (not the rate-limited API), but cap
      // concurrency so a big icon set doesn't open dozens of sockets.
      await mapLimit(svgIds as string[], 6, async (id) => {
        const u = res.images?.[id];
        if (!u) return;
        try {
          const r = await fetch(u);
          if (r.ok) svg[id] = sanitizeSvg(await r.text());
        } catch {
          /* skip a failed icon */
        }
      });
    }

    if (pngIds.length) {
      const res = await getImages(token, fileKey, pngIds, "png", 2);
      for (const id of pngIds) {
        const u = res.images?.[id];
        if (u) png[id] = u;
      }
    }

    return NextResponse.json({ svg, png });
  } catch (e) {
    const err = e as FigmaError;
    return NextResponse.json(
      { error: err.message ?? "Не удалось получить ассеты" },
      { status: err.status ?? 500 },
    );
  }
}

/** Trim Figma's XML preamble and width/height so our CSS controls sizing. */
function sanitizeSvg(raw: string): string {
  return raw
    .replace(/<\?xml[^>]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s(width|height)="[^"]*"/gi, "")
    .trim();
}
