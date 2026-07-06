import { NextRequest, NextResponse } from "next/server";
import { convertNode, convertNodes } from "@/lib/figma/convert";
import type { FigmaNode } from "@/lib/figma/types";

export const runtime = "nodejs";

/**
 * POST /api/convert
 * body: {
 *   node: FigmaNode,               // single node, or a synthetic GROUP
 *   nodes?: FigmaNode[],           // optional multi-selection
 *   assets?: { svg?: {}, png?: {} },
 *   useTokens?: boolean,
 *   semantic?: boolean,
 *   inferLayout?: boolean,         // inferred auto-layout → flex (opt-in)
 *   responsive?: boolean,          // fluid root: w-full + max-w (opt-in)
 *   mode?: "combine" | "separate",
 * }
 * Returns generated code for every target: { react, html, vue, cssJsx, cssCss }.
 * Mirrors the client-side conversion in src/app/page.tsx so a plain static
 * page can show the exact same output without importing the TS modules.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const node: FigmaNode | undefined = body.node;
    const nodes: FigmaNode[] | undefined = body.nodes;
    if (!node && !(nodes && nodes.length)) {
      return NextResponse.json({ error: "node или nodes обязательны" }, { status: 400 });
    }

    const opts = {
      absolutePositioning: true,
      useTokens: !!body.useTokens,
      semantic: body.semantic !== false,
      inferLayout: !!body.inferLayout,
      responsive: !!body.responsive,
    };

    const converted =
      nodes && nodes.length > 1
        ? convertNodes(nodes, body.mode === "separate" ? "separate" : "combine", opts)
        : convertNode((nodes && nodes[0]) || (node as FigmaNode), opts);

    const svg: Record<string, string> = body.assets?.svg ?? {};
    const png: Record<string, string> = body.assets?.png ?? {};

    // Replace @@ASSET@@ placeholders — same two strategies as the app:
    // "datauri" keeps the <img> (JSX-friendly); "inline" swaps in the raw <svg>.
    const inject = (text: string, m: "datauri" | "inline") => {
      let res = text;
      for (const a of converted.assets) {
        if (a.kind === "svg") {
          const markup = svg[a.id];
          if (m === "datauri") {
            const dataUri = markup ? `data:image/svg+xml,${encodeURIComponent(markup)}` : "";
            res = res.replace(`@@ASSET:${a.id}@@`, dataUri);
          } else if (markup) {
            const svgWithClass = markup.replace(/<svg\b/, `<svg class="${a.className}"`);
            res = res.replace(
              new RegExp(`<img class="[^"]*"[^>]*?src="@@ASSET:${a.id}@@"[^>]*/>`),
              svgWithClass,
            );
          }
        } else {
          res = res.replace(`@@ASSET:${a.id}@@`, png[a.id] ?? "");
        }
      }
      return res;
    };

    const themeCss = converted.themeCss;
    const reactHeader = themeCss ? `/* Tailwind v4 — вставьте в globals.css:\n${themeCss}*/\n\n` : "";
    const htmlHeader = themeCss ? `<!-- Tailwind v4 — вставьте в globals.css:\n${themeCss}-->\n` : "";

    return NextResponse.json({
      componentName: converted.componentName,
      react: reactHeader + inject(converted.code, "datauri"),
      html: htmlHeader + inject(converted.html, "inline"),
      vue: inject(converted.vue, "inline"),
      cssJsx: inject(converted.cssModule.jsx, "datauri"),
      cssCss: converted.cssModule.css,
      warnings: converted.warnings,
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message ?? "Ошибка конвертации" }, { status: 500 });
  }
}
