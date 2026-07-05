import { NextRequest, NextResponse } from "next/server";
import { getImages, parseFigmaUrl, FigmaError } from "@/lib/figma/client";

export const runtime = "nodejs";

/**
 * POST /api/figma/images
 * body: { token, url|fileKey, ids: string[], format?, scale? }
 * Returns rendered preview image URLs keyed by node id.
 */
export async function POST(req: NextRequest) {
  try {
    const { token, url, fileKey: fk, ids, format, scale } = await req.json();
    if (!token || !ids?.length) {
      return NextResponse.json(
        { error: "token и ids обязательны" },
        { status: 400 },
      );
    }
    const fileKey = fk || parseFigmaUrl(url).fileKey;
    const res = await getImages(token, fileKey, ids, format ?? "png", scale ?? 2);
    if (res.err) {
      return NextResponse.json({ error: res.err }, { status: 502 });
    }
    return NextResponse.json({ images: res.images });
  } catch (e) {
    const err = e as FigmaError;
    return NextResponse.json(
      { error: err.message ?? "Неизвестная ошибка" },
      { status: err.status ?? 500 },
    );
  }
}
