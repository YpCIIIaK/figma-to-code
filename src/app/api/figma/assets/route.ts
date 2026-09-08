import { NextRequest, NextResponse } from "next/server";
import { getImages, mapLimit, parseFigmaUrl, FigmaError } from "@/lib/figma/client";
import { sanitizeSvg, isBloatedSvg } from "@/lib/figma/svg";

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
      const bloated: string[] = [];
      await mapLimit(svgIds as string[], 6, async (id) => {
        const u = res.images?.[id];
        if (!u) return;
        try {
          const r = await fetch(u);
          if (!r.ok) return;
          const markup = sanitizeSvg(await r.text());
          // Figma inlines the whole bitmap when a vector is filled with an
          // image; URI-encoded that dwarfs the plain PNG, so render one instead.
          if (isBloatedSvg(markup)) bloated.push(id);
          else svg[id] = markup;
        } catch {
          /* skip a failed icon */
        }
      });
      if (bloated.length) {
        const raster = await getImages(token, fileKey, bloated, "png", 2);
        // The client treats a non-"<" value here as a ready-to-use image src.
        for (const id of bloated) {
          const u = raster.images?.[id];
          if (u) svg[id] = u;
        }
      }
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



