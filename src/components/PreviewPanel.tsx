"use client";

import { useEffect, useMemo, useState } from "react";
import type { PreviewTheme } from "@/lib/figma/convert";

type Tab = "figma" | "render";

// Checkerboard is rendered inside the iframe body so it scrolls with content.
const CHECKER =
  "repeating-conic-gradient(#d7d7dd 0% 25%, #f2f2f5 0% 50%) 50% / 24px 24px";

function buildSrcDoc(html: string, theme: PreviewTheme | null | undefined, bg: string): string {
  // Feed token names to the Tailwind Play CDN so bg-purple-500 / font-inter
  // render with the design's actual values inside the preview.
  const hasTheme =
    theme &&
    (Object.keys(theme.colors).length ||
      Object.keys(theme.fontFamily).length ||
      Object.keys(theme.spacing ?? {}).length ||
      Object.keys(theme.borderRadius ?? {}).length ||
      Object.keys(theme.fontSize ?? {}).length);
  const config = hasTheme
    ? `<script>tailwind.config={theme:{extend:{colors:${JSON.stringify(
        theme!.colors,
      )},fontFamily:${JSON.stringify(theme!.fontFamily)},spacing:${JSON.stringify(
        theme!.spacing ?? {},
      )},borderRadius:${JSON.stringify(
        theme!.borderRadius ?? {},
      )},fontSize:${JSON.stringify(theme!.fontSize ?? {})}}}}</script>`
    : "";
  const background = bg === "checker" ? CHECKER : bg;
  return `<!doctype html><html><head>
<meta charset="utf-8" />
<script src="https://cdn.tailwindcss.com"></script>${config}
<style>body{margin:0;display:flex;align-items:flex-start;justify-content:center;padding:24px;background:${background};}</style>
</head><body>${html}</body></html>`;
}

const PRESETS: { value: string; title: string; swatch: string }[] = [
  { value: "#ffffff", title: "Белый", swatch: "#ffffff" },
  { value: "#18181b", title: "Тёмный", swatch: "#18181b" },
  { value: "checker", title: "Шахматка (прозрачность)", swatch: CHECKER },
];

export default function PreviewPanel({
  imageUrl,
  html,
  loading,
  theme,
}: {
  imageUrl: string | null;
  html: string;
  loading: boolean;
  theme?: PreviewTheme | null;
}) {
  const [tab, setTab] = useState<Tab>("figma");
  const [bg, setBg] = useState("#ffffff");

  // Restore the last chosen render background.
  useEffect(() => {
    const saved = localStorage.getItem("render-bg");
    if (saved) setBg(saved);
  }, []);
  const pickBg = (v: string) => {
    setBg(v);
    localStorage.setItem("render-bg", v);
  };

  const srcDoc = useMemo(
    () => (html ? buildSrcDoc(html, theme, bg) : ""),
    [html, theme, bg],
  );

  const isCustom = bg !== "checker" && !PRESETS.some((p) => p.value === bg);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {(["figma", "render"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              tab === t
                ? "bg-white/10 text-white"
                : "text-foreground/50 hover:text-foreground"
            }`}
          >
            {t === "figma" ? "Figma превью" : "Рендер кода"}
          </button>
        ))}

        {/* Background picker — only relevant for the code render tab. */}
        {tab === "render" && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-foreground/40">Фон</span>
            {PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => pickBg(p.value)}
                title={p.title}
                className={`h-5 w-5 rounded-full border ${
                  bg === p.value
                    ? "border-accent ring-1 ring-accent"
                    : "border-white/20 hover:border-white/50"
                }`}
                style={{ background: p.swatch }}
              />
            ))}
            {/* Custom color: the swatch doubles as a native color input. */}
            <label
              title="Свой цвет"
              className={`relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border ${
                isCustom
                  ? "border-accent ring-1 ring-accent"
                  : "border-white/20 hover:border-white/50"
              }`}
              style={{
                background: isCustom
                  ? bg
                  : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
              }}
            >
              <input
                type="color"
                value={isCustom ? bg : "#808080"}
                onChange={(e) => pickBg(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
          </div>
        )}
      </div>

      <div
        className="relative flex-1 overflow-auto"
        style={{
          backgroundImage:
            "repeating-conic-gradient(#1a1f29 0% 25%, #151a23 0% 50%)",
          backgroundSize: "24px 24px",
        }}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-foreground/60">
            Загрузка превью…
          </div>
        )}
        {tab === "figma" ? (
          imageUrl ? (
            <div className="flex min-h-full items-start justify-center p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="Figma preview"
                className="max-w-full shadow-2xl"
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-foreground/40">
              Нет превью — выберите блок.
            </div>
          )
        ) : srcDoc ? (
          <iframe
            title="Рендер кода"
            className="h-full w-full border-0"
            style={{ background: bg === "checker" ? "#f2f2f5" : bg }}
            sandbox="allow-scripts"
            srcDoc={srcDoc}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-foreground/40">
            Нет кода для рендера.
          </div>
        )}
      </div>
    </div>
  );
}
