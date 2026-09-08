import { NextRequest, NextResponse } from "next/server";
import {
  getFile,
  getNodes,
  parseFigmaUrl,
  normalizeRotation,
  FigmaError,
} from "@/lib/figma/client";
import { toTree, findNode } from "@/lib/figma/tree";
import type { FigmaNode } from "@/lib/figma/types";

export const runtime = "nodejs";

/**
 * POST /api/figma/file
 * body: { token, url, nodeId? }
 * Returns the (selected) node subtree + a trimmed layer tree.
 */
export async function POST(req: NextRequest) {
  try {
    const { token, url, nodeId: nodeIdOverride } = await req.json();
    if (!token || !url) {
      return NextResponse.json(
        { error: "token и url обязательны" },
        { status: 400 },
      );
    }

    const { fileKey, nodeId: urlNodeId } = parseFigmaUrl(url);
    const nodeId = nodeIdOverride || urlNodeId;

    let root: FigmaNode;
    let fileName: string;

    if (nodeId) {
      const res = await getNodes(token, fileKey, [nodeId]);
      const entry = res.nodes[nodeId];
      if (!entry?.document) {
        return NextResponse.json(
          { error: `Узел ${nodeId} не найден в файле` },
          { status: 404 },
        );
      }
      root = entry.document;
      fileName = res.name;
    } else {
      // No node selected: load the file shallow, use first page/canvas.
      const file = await getFile(token, fileKey);
      fileName = file.name;
      const firstPage = file.document.children?.[0];
      root = firstPage ?? file.document;
    }

    // REST speaks radians; the converter speaks CSS degrees (as the plugin
    // payload does). Normalize once, at the boundary.
    normalizeRotation(root);

    return NextResponse.json({
      fileKey,
      fileName,
      rootId: root.id,
      tree: toTree(root),
      node: root,
    });
  } catch (e) {
    const err = e as FigmaError;
    const status = err.status ?? 500;
    return NextResponse.json(
      { error: err.message ?? "Неизвестная ошибка" },
      { status },
    );
  }
}
