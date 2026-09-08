import { NextRequest, NextResponse } from "next/server";
import { convertNode, convertNodes } from "@/lib/figma/convert";
import type { FigmaNode } from "@/lib/figma/types";

export const runtime = "nodejs";

// The Figma plugin UI runs in a sandboxed (cross-origin) iframe and calls this
// route directly to render code + preview without opening the web app.
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
 * body: {
 *   node: FigmaNode,               // single node, or a synthetic GROUP
 *   nodes?: FigmaNode[],           // optional multi-selection
 *   assets?: { svg?: {}, png?: {} },
 *   useTokens?: boolean,
 *   semantic?: boolean,
 *   inferLayout?: boolean,         // inferred auto-layout → flex (opt-in)
 *   responsive?: boolean,          // fluid root: w-full + max-w (opt-in)
 *   layerNames?: boolean,          // keep Figma layer names as data-name (opt-in)
 *   variables?: FigmaVariable[],   // design tokens from the plugin payload
 *   assetMode?: "inline" | "paths", // inline bytes (default) or src="assets/x.svg"
 *   assetDir?: string,             // folder prefix for "paths" mode (default "assets")
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
      return NextResponse.json(
        { error: "node или nodes обязательны" },
        { status: 400, headers: CORS },
      );
    }

    const opts = {
      absolutePositioning: true,
      useTokens: !!body.useTokens,
      semantic: body.semantic !== false,
      inferLayout: !!body.inferLayout,
      responsive: !!body.responsive,
      layerNames: !!body.layerNames,
      // Figma variables (plugin payload) — token mode names colours/spacing
      // after the real design tokens instead of inventing names.
      variables: body.variables,
    };

    const converted =
      nodes && nodes.length > 1
        ? convertNodes(nodes, body.mode === "separate" ? "separate" : "combine", opts)
        : convertNode((nodes && nodes[0]) || (node as FigmaNode), opts);

    const svg: Record<string, string> = body.assets?.svg ?? {};
    const png: Record<string, string> = body.assets?.png ?? {};

    // Emit assets as file paths instead of inlined bytes. Keeps the copied
    // code readable when the designer drops the exported files in by hand.
    const paths = body.assetMode === "paths";
    const assetDir: string = (body.assetDir ?? "assets").replace(/\/+$/, "");
    const used = new Set<string>();
    /** Stable, unique, filesystem-safe file name for one asset. */
    const assetPath = (a: { id: string; kind: "svg" | "png"; name?: string }) => {
      const base =
        (a.name ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9а-я]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "asset";
      let file = base;
      // Two layers can share a name — suffix the duplicates so paths stay unique.
      for (let i = 2; used.has(file); i++) file = `${base}-${i}`;
      used.add(file);
      return `${assetDir ? assetDir + "/" : ""}${file}.${a.kind}`;
    };
    const pathOf = new Map(converted.assets.map((a) => [a.id, assetPath(a)]));

    // Replace @@ASSET@@ placeholders. "datauri" keeps the <img> (JSX-friendly),
    // "inline" swaps in the raw <svg>; asPaths overrides both with a bare file
    // path so the copied code stays readable and the designer drops the
    // exported files in himself.
    const substitute = (text: string, m: "datauri" | "inline", asPaths: boolean) => {
      let res = text;
      for (const a of converted.assets) {
        if (asPaths) {
          res = res.split(`@@ASSET:${a.id}@@`).join(pathOf.get(a.id)!);
          continue;
        }
        if (a.kind === "svg") {
          const markup = svg[a.id];
          // An SVG too heavy to inline arrives already rasterized — a plain
          // image URL / data URI. It goes straight into src="…"; treating it
          // as markup would splice a giant base64 blob into the document text.
          if (markup && !markup.trimStart().startsWith("<")) {
            res = res.split(`@@ASSET:${a.id}@@`).join(markup);
          } else if (m === "datauri") {
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
    const inject = (text: string, m: "datauri" | "inline") => substitute(text, m, paths);

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
      // Always-inlined markup for a live preview (the code above may carry
      // bare file paths that a preview iframe could never resolve).
      previewHtml: substitute(converted.html, "inline", false),
      // The files the code now points at, so a caller can offer to save them.
      assetFiles: paths
        ? converted.assets.map((a) => ({
            id: a.id,
            path: pathOf.get(a.id)!,
            kind: a.kind,
          }))
        : [],
      // Palette/fonts so a caller (the plugin) can configure its preview
      // Tailwind exactly like the app's PreviewPanel does.
      previewTheme: converted.previewTheme ?? null,
      warnings: converted.warnings,
    }, { headers: CORS });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: err.message ?? "Ошибка конвертации" },
      { status: 500, headers: CORS },
    );
  }
}
