"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

// Monaco is heavy and browser-only — load it lazily, never on the server.
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-foreground/40">
      Загрузка редактора…
    </div>
  ),
});

type Tab = "react" | "html" | "vue" | "css";

const kb = (chars: number) => `${Math.max(1, Math.round(chars / 1024))} КБ`;

/**
 * Display-only shortening of embedded assets: long data: URIs and inline
 * <svg> blocks become compact placeholders with their size. The real code
 * (copy button, ZIP, preview) is never touched.
 */
function collapseAssets(code: string): string {
  return code
    .replace(
      /(["'(])(data:[^"'()]{120,})(["')])/g,
      (_, open, uri: string, close) =>
        `${open}${uri.slice(0, 32)}…[картинка, ${kb(uri.length)}]${close}`,
    )
    .replace(/(<svg\b[^>]*>)[\s\S]{200,}?(<\/svg>)/g, (m, open, close) =>
      m.length < 300 ? m : `${open}<!-- svg, ${kb(m.length)} -->${close}`,
    );
}

const TABS: [Tab, string][] = [
  ["react", "React + Tailwind"],
  ["html", "HTML"],
  ["vue", "Vue"],
  ["css", "CSS-modules"],
];

export default function CodePanel({
  reactCode,
  htmlCode,
  vueCode,
  cssJsx,
  cssText,
  onHtmlEdit,
  onResetHtml,
  htmlEdited,
  onDownloadZip,
  canExport,
}: {
  reactCode: string;
  htmlCode: string;
  vueCode: string;
  cssJsx: string;
  cssText: string;
  /** push edited HTML to the live preview (debounced) */
  onHtmlEdit?: (html: string) => void;
  /** discard the saved edit and revert to generated HTML */
  onResetHtml?: () => void;
  /** the current selection already has a saved manual edit */
  htmlEdited?: boolean;
  /** bundle every format + assets into a .zip download */
  onDownloadZip?: () => void;
  canExport?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("react");
  const [copied, setCopied] = useState(false);
  const [edited, setEdited] = useState(false);
  // Collapse embedded images/SVGs in the *displayed* code (copy stays full).
  const [collapsed, setCollapsed] = useState(true);

  // Editable HTML buffer, re-seeded whenever the resolved code changes. Edits are
  // persisted per-node upstream, so switching back restores them automatically.
  const [htmlBuf, setHtmlBuf] = useState(htmlCode);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setHtmlBuf(htmlCode);
    setEdited(false);
  }, [htmlCode]);

  const isEdited = edited || !!htmlEdited;

  // CSS-modules tab shows the component JSX and its stylesheet together.
  const cssCombined =
    cssJsx || cssText
      ? `${cssJsx}\n/* ---------- ${"styles.module.css"} ---------- */\n\n${cssText}`
      : "";

  const code =
    tab === "react"
      ? reactCode
      : tab === "html"
        ? htmlBuf
        : tab === "vue"
          ? vueCode
          : cssCombined;

  const language =
    tab === "react" || tab === "css"
      ? "javascript"
      : tab === "vue"
        ? "html"
        : "html";

  // What the editor shows; identical to `code` unless assets are collapsed.
  const shortened = collapseAssets(code);
  const hasAssets = shortened !== code;
  const displayCode = collapsed ? shortened : code;

  const onChange = (value?: string) => {
    const v = value ?? "";
    // Editing while assets are collapsed would save the placeholders — the
    // HTML tab becomes read-only until the user expands the assets.
    if (tab !== "html" || collapsed) return;
    setHtmlBuf(v);
    setEdited(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onHtmlEdit?.(v), 300);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                tab === t
                  ? "bg-white/10 text-white"
                  : "text-foreground/50 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
          {tab === "html" && (
            <span className="flex items-center gap-1.5 pl-1 text-[11px] text-foreground/40">
              {collapsed && hasAssets
                ? "разверните картинки для правок"
                : isEdited
                  ? "правки → превью"
                  : "редактируемо"}
              {isEdited && onResetHtml && (
                <button
                  onClick={onResetHtml}
                  title="Сбросить правки этого блока"
                  className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground/60 hover:text-foreground"
                >
                  сброс
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasAssets && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              title="Сворачивать длинные data:-URI и inline-SVG в отображении кода (копирование и ZIP всегда с полными данными)"
              className={`rounded border px-2 py-1 text-xs font-medium ${
                collapsed
                  ? "border-accent bg-accent/20 text-white"
                  : "border-border text-foreground/50 hover:text-foreground"
              }`}
            >
              {collapsed ? "Картинки свёрнуты" : "Картинки полностью"}
            </button>
          )}
          <button
            onClick={onDownloadZip}
            disabled={!canExport}
            title="Скачать все форматы + ассеты + tokens.css в .zip"
            className="rounded border border-border px-3 py-1 text-xs font-semibold text-foreground/70 hover:text-foreground disabled:opacity-30"
          >
            ⬇ ZIP
          </button>
          <button
            onClick={copy}
            disabled={!code}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white disabled:opacity-30"
          >
            {copied ? "Скопировано ✓" : "Копировать"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {code ? (
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            language={language}
            value={displayCode}
            onChange={onChange}
            path={
              tab === "react"
                ? "component.jsx"
                : tab === "vue"
                  ? "component.vue"
                  : tab === "css"
                    ? "component.module.jsx"
                    : "markup.html"
            }
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              wordWrap: "on",
              readOnly: tab !== "html" || (collapsed && hasAssets),
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderLineHighlight: "line",
              padding: { top: 12, bottom: 12 },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-foreground/40">
            Выберите блок в дереве слоёв
          </div>
        )}
      </div>
    </div>
  );
}
