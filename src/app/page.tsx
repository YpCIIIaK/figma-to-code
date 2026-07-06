"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LayerTree from "@/components/LayerTree";
import CodePanel from "@/components/CodePanel";
import PreviewPanel from "@/components/PreviewPanel";
import TokensPanel from "@/components/TokensPanel";
import { convertNode, convertNodes, combineNodes } from "@/lib/figma/convert";
import { findNode, toTree } from "@/lib/figma/tree";
import type { FigmaNode, TreeNode, VarToken } from "@/lib/figma/types";
import { makeZip, downloadBlob, dataUriToBytes, type ZipEntry } from "@/lib/zip";
import {
  loadEdits,
  saveEdit,
  deleteEdit,
  loadHistory,
  saveHistory,
  removeHistory,
  type HistoryEntry,
} from "@/lib/storage";

export default function Home() {
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fileKey, setFileKey] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [rootNode, setRootNode] = useState<FigmaNode | null>(null);

  // Multi-select: a set of checked node ids + one "active" node (last clicked)
  // that drives the Figma image preview.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [multiMode, setMultiMode] = useState<"combine" | "separate">("combine");
  const [useTokens, setUseTokens] = useState(false);
  const [semantic, setSemantic] = useState(true);
  // Turn Figma's inferred auto-layout on free-form frames into flex (opt-in:
  // changes absolute-positioned output into flow layout, so off by default).
  const [inferLayout, setInferLayout] = useState(false);
  // Fluid root (w-full + max-w) so the block adapts to narrow viewports (opt-in).
  const [responsive, setResponsive] = useState(false);
  // Design-system variables from the plugin payload (color/primary/500, etc.).
  const [variables, setVariables] = useState<VarToken[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"code" | "tokens">("code");

  // Input source: REST (token) or the Figma companion plugin (no token/limits).
  const [inputMode, setInputMode] = useState<"rest" | "plugin">("rest");
  const [pluginConnected, setPluginConnected] = useState(false);

  // Recently loaded files (restorable without a REST call) + per-node HTML edits.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const editsRef = useRef<Record<string, string>>({});
  const [htmlGenerated, setHtmlGenerated] = useState("");
  const [htmlIsEdited, setHtmlIsEdited] = useState(false);

  // Cache rendered preview URLs by node id, and debounce/guard requests so
  // rapid clicking through the layer tree doesn't trip Figma's rate limit (429).
  const previewCache = useRef<Map<string, string | null>>(new Map());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestedId = useRef<string | null>(null);

  // Restore the token (Figma PAT) from localStorage.
  useEffect(() => {
    const t = localStorage.getItem("figma-token");
    if (t) setToken(t);
    const u = localStorage.getItem("figma-url");
    if (u) setUrl(u);
    editsRef.current = loadEdits();
    setHistory(loadHistory());
  }, []);

  // A stable key for the current output config — edits are saved per exact
  // selection + toggle combination, so restoring them never shows stale code.
  const selectionKey = useMemo(() => {
    const ids = [...selectedIds].sort().join(",");
    return `${fileKey ?? ""}|${ids}|${multiMode}|${useTokens ? 1 : 0}|${semantic ? 1 : 0}|${inferLayout ? 1 : 0}|${responsive ? 1 : 0}`;
  }, [fileKey, selectedIds, multiMode, useTokens, semantic, inferLayout, responsive]);

  // Resolve checked ids to actual nodes (tree is already loaded client-side).
  const selectedNodes = useMemo(() => {
    if (!rootNode) return [];
    return [...selectedIds]
      .map((id) => findNode(rootNode, id))
      .filter((n): n is FigmaNode => !!n);
  }, [rootNode, selectedIds]);

  const converted = useMemo(() => {
    if (!selectedNodes.length) return null;
    const opts = { absolutePositioning: true, useTokens, semantic, inferLayout, responsive, variables };
    if (selectedNodes.length === 1) return convertNode(selectedNodes[0], opts);
    return convertNodes(selectedNodes, multiMode, opts);
  }, [selectedNodes, multiMode, useTokens, semantic, inferLayout, responsive, variables]);

  // Node fed to the token extractor (synthetic group when multiple selected).
  const tokenNode = useMemo(() => {
    if (!selectedNodes.length) return null;
    if (selectedNodes.length === 1) return selectedNodes[0];
    return combineNodes(selectedNodes);
  }, [selectedNodes]);

  // Resolved (asset-injected) outputs shown in the UI.
  const [reactCode, setReactCode] = useState("");
  const [htmlCode, setHtmlCode] = useState("");
  const [vueCode, setVueCode] = useState("");
  const [cssJsx, setCssJsx] = useState("");
  const [cssText, setCssText] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const assetCache = useRef<Map<string, string>>(new Map());

  // Apply a payload pushed by the Figma plugin: it already carries the node
  // tree and pre-rendered assets, so no REST calls (and no 429s) are needed.
  const applyPlugin = useCallback(
    (data: {
      fileName?: string;
      node: FigmaNode;
      assets?: { svg?: Record<string, string>; png?: Record<string, string> };
      preview?: string | null;
      variables?: VarToken[];
    }) => {
      const node = data.node;
      for (const [id, m] of Object.entries(data.assets?.svg ?? {}))
        assetCache.current.set(`svg:${id}`, m);
      for (const [id, u] of Object.entries(data.assets?.png ?? {}))
        assetCache.current.set(`png:${id}`, u);
      setError(null);
      setFileKey("plugin");
      const fname = data.fileName || "Figma plugin";
      setFileName(fname);
      const tr = toTree(node);
      setTree(tr);
      setRootNode(node);
      setActiveId(node.id);
      setSelectedIds(new Set([node.id]));
      setPreviewUrl(data.preview ?? null);
      setPreviewLoading(false);
      const vars = data.variables ?? [];
      setVariables(vars);
      // A payload carrying real design-system variables → default to token
      // mode so the generated code shows bg-primary-500 out of the box.
      if (vars.length) setUseTokens(true);
      const entry: HistoryEntry = {
        fileKey: "plugin",
        fileName: fname,
        source: "plugin",
        savedAt: Date.now(),
        node,
        tree: tr,
        variables: vars,
      };
      setHistory((h) => saveHistory(entry, h));
    },
    [],
  );

  // Subscribe to the plugin relay (SSE) while in plugin mode.
  useEffect(() => {
    if (inputMode !== "plugin") return;
    const es = new EventSource("/api/plugin/stream");
    es.onopen = () => setPluginConnected(true);
    es.onerror = () => setPluginConnected(false);
    es.onmessage = (e) => {
      try {
        applyPlugin(JSON.parse(e.data));
      } catch {
        /* ignore malformed payloads */
      }
    };
    return () => {
      es.close();
      setPluginConnected(false);
    };
  }, [inputMode, applyPlugin]);

  // When the converted node changes, fetch its icons/images and inject them.
  useEffect(() => {
    // In token mode, prepend the @theme block as a copy-paste header (valid
    // JS/HTML comment); the live preview gets the palette via Tailwind config.
    const themeCss = converted?.themeCss;
    const reactHeader = themeCss
      ? `/* Tailwind v4 — вставьте в globals.css:\n${themeCss}*/\n\n`
      : "";
    const htmlHeader = themeCss
      ? `<!-- Tailwind v4 — вставьте в globals.css:\n${themeCss}-->\n`
      : "";

    if (!converted || !fileKey) {
      const gen = htmlHeader + (converted?.html ?? "");
      const edit = editsRef.current[selectionKey];
      setReactCode(reactHeader + (converted?.code ?? ""));
      setHtmlGenerated(gen);
      setHtmlCode(edit ?? gen);
      setHtmlIsEdited(!!edit);
      setVueCode(converted?.vue ?? "");
      setCssJsx(converted?.cssModule.jsx ?? "");
      setCssText(converted?.cssModule.css ?? "");
      setPreviewHtml(edit ?? converted?.html ?? "");
      return;
    }
    let cancelled = false;
    const { code, html, vue, cssModule, assets } = converted;

    // Replace @@ASSET@@ placeholders. "datauri" keeps the <img> (JSX-friendly),
    // "inline" swaps the whole <img> for the real <svg> (crisp HTML/Vue render).
    const inject = (
      text: string,
      mode: "datauri" | "inline",
      svg: Record<string, string>,
      png: Record<string, string>,
    ) => {
      let res = text;
      for (const a of assets) {
        if (a.kind === "svg") {
          const markup = svg[a.id];
          if (mode === "datauri") {
            const dataUri = markup
              ? `data:image/svg+xml,${encodeURIComponent(markup)}`
              : "";
            res = res.replace(`@@ASSET:${a.id}@@`, dataUri);
          } else if (markup) {
            const svgWithClass = markup.replace(
              /<svg\b/,
              `<svg class="${a.className}"`,
            );
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

    const apply = (svg: Record<string, string>, png: Record<string, string>) => {
      if (cancelled) return;
      const resHtml = inject(html, "inline", svg, png);
      const genHtml = htmlHeader + resHtml;
      const edit = editsRef.current[selectionKey];
      setReactCode(reactHeader + inject(code, "datauri", svg, png));
      setHtmlGenerated(genHtml);
      setHtmlCode(edit ?? genHtml);
      setHtmlIsEdited(!!edit);
      setVueCode(inject(vue, "inline", svg, png));
      setCssJsx(inject(cssModule.jsx, "datauri", svg, png));
      setCssText(cssModule.css);
      setPreviewHtml(edit ?? resHtml);
    };

    if (!assets.length) {
      apply({}, {});
      return;
    }

    // Split into not-yet-cached ids; serve cached ones instantly.
    const svgCached: Record<string, string> = {};
    const svgIds: string[] = [];
    const pngCached: Record<string, string> = {};
    const pngIds: string[] = [];
    for (const a of assets) {
      const hit = assetCache.current.get(`${a.kind}:${a.id}`);
      if (hit != null) {
        if (a.kind === "svg") svgCached[a.id] = hit;
        else pngCached[a.id] = hit;
      } else if (a.kind === "svg") svgIds.push(a.id);
      else pngIds.push(a.id);
    }

    // Show text immediately with whatever is cached.
    apply(svgCached, pngCached);

    if (!svgIds.length && !pngIds.length) return;
    // Plugin mode pre-fills the cache locally — never hit the REST asset API.
    if (fileKey === "plugin") return;

    (async () => {
      // The server already retries 429s with backoff; this adds one more
      // delayed attempt so a still-throttled response recovers on its own
      // instead of leaving placeholders until the node is re-selected.
      const attempt = async (): Promise<boolean> => {
        const res = await fetch("/api/figma/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, fileKey, svgIds, pngIds }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (cancelled) return true;
        const svg = { ...svgCached, ...(data.svg ?? {}) };
        const png = { ...pngCached, ...(data.png ?? {}) };
        for (const [id, m] of Object.entries(data.svg ?? {}))
          assetCache.current.set(`svg:${id}`, m as string);
        for (const [id, u] of Object.entries(data.png ?? {}))
          assetCache.current.set(`png:${id}`, u as string);
        apply(svg, png);
        return true;
      };
      try {
        if (await attempt()) return;
        await new Promise((r) => setTimeout(r, 4000));
        if (!cancelled) await attempt();
      } catch {
        /* keep placeholders on failure */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [converted, fileKey, token, selectionKey]);

  // Bundle every generated format + assets + tokens into a downloadable .zip.
  const downloadZip = useCallback(() => {
    if (!converted) return;
    const name = converted.componentName || "Component";
    const files: ZipEntry[] = [
      { name: `${name}.tsx`, data: reactCode },
      { name: `${name}.html`, data: htmlCode },
      { name: `${name}.vue`, data: vueCode },
      { name: `${name}.module.tsx`, data: cssJsx },
      { name: `${name}.module.css`, data: cssText },
    ];
    if (converted.themeCss) files.push({ name: "tokens.css", data: converted.themeCss });

    const pngNotes: string[] = [];
    for (const a of converted.assets) {
      const hit = assetCache.current.get(`${a.kind}:${a.id}`);
      if (!hit) continue;
      const safe = a.id.replace(/:/g, "-");
      if (a.kind === "svg") {
        files.push({ name: `assets/${safe}.svg`, data: hit });
      } else {
        const bytes = dataUriToBytes(hit);
        if (bytes) files.push({ name: `assets/${safe}.png`, data: bytes });
        else pngNotes.push(`${safe}.png → ${hit}`);
      }
    }

    const readme =
      `Figma Copy — экспорт «${fileName || name}»\n\n` +
      `Файлы:\n` +
      `  ${name}.tsx          React + Tailwind\n` +
      `  ${name}.html         HTML + Tailwind (CDN)\n` +
      `  ${name}.vue          Vue 3 SFC\n` +
      `  ${name}.module.tsx   React + CSS-modules\n` +
      `  ${name}.module.css   стили к .module.tsx\n` +
      (converted.themeCss ? `  tokens.css           Tailwind v4 @theme токены\n` : "") +
      `  assets/              иконки (svg) и картинки (png)\n` +
      (pngNotes.length
        ? `\nКартинки по ссылке (не встроены — внешний URL):\n  ${pngNotes.join("\n  ")}\n`
        : "");
    files.push({ name: "README.txt", data: readme });

    downloadBlob(makeZip(files), `${name}.zip`);
  }, [converted, reactCode, htmlCode, vueCode, cssJsx, cssText, fileName]);

  // Persist a manual HTML edit for the current selection and live-update preview.
  const handleHtmlEdit = useCallback(
    (html: string) => {
      setPreviewHtml(html);
      saveEdit(editsRef.current, selectionKey, html);
      setHtmlIsEdited(true);
    },
    [selectionKey],
  );

  // Discard the saved edit and revert to the freshly generated HTML.
  const resetHtml = useCallback(() => {
    deleteEdit(editsRef.current, selectionKey);
    setHtmlIsEdited(false);
    setHtmlCode(htmlGenerated);
    // strip the leading @theme comment for the live preview
    setPreviewHtml(htmlGenerated.replace(/^<!--[\s\S]*?-->\n/, ""));
  }, [selectionKey, htmlGenerated]);

  // Restore a previously loaded file from local cache — no REST call.
  const restoreEntry = useCallback((entry: HistoryEntry) => {
    setError(null);
    setShowHistory(false);
    setInputMode(entry.source);
    setFileKey(entry.fileKey);
    setFileName(entry.fileName);
    if (entry.url) setUrl(entry.url);
    setTree(entry.tree);
    setRootNode(entry.node);
    setActiveId(entry.node.id);
    setSelectedIds(new Set([entry.node.id]));
    setVariables(entry.variables ?? []);
    setPreviewUrl(null);
  }, []);

  const fetchPreview = useCallback(
    async (id: string, key?: string) => {
      const fk = key ?? fileKey;
      if (!fk) return;

      // Plugin mode has no REST access: the only preview is the flat PNG the
      // plugin pushed for the root selection. Never call /api/figma/images
      // here — it would 404 (fileKey "plugin", no token).
      if (fk === "plugin") {
        setPreviewLoading(false);
        return;
      }

      // Serve from cache instantly — no network call, no rate-limit risk.
      if (previewCache.current.has(id)) {
        setPreviewUrl(previewCache.current.get(id) ?? null);
        setPreviewLoading(false);
        return;
      }

      lastRequestedId.current = id;
      setError(null);
      setPreviewLoading(true);
      setPreviewUrl(null);
      try {
        const res = await fetch("/api/figma/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, fileKey: fk, ids: [id] }),
        });
        const data = await res.json();
        if (res.ok) {
          const url = data.images?.[id] ?? null;
          previewCache.current.set(id, url);
          // Ignore the response if the user already moved to another node.
          if (lastRequestedId.current === id) setPreviewUrl(url);
        } else if (lastRequestedId.current === id) {
          setError(data.error ?? "Не удалось получить превью");
        }
      } catch {
        /* ignore preview errors */
      } finally {
        if (lastRequestedId.current === id) setPreviewLoading(false);
      }
    },
    [fileKey, token],
  );

  // Debounced wrapper: only the node you settle on triggers a render request.
  const queuePreview = useCallback(
    (id: string, key?: string) => {
      // In plugin mode there's nothing to render per-node; keep the flat
      // preview the plugin pushed and skip any REST request.
      if ((key ?? fileKey) === "plugin") return;
      if (previewCache.current.has(id)) {
        setPreviewUrl(previewCache.current.get(id) ?? null);
        return;
      }
      setPreviewLoading(true);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => fetchPreview(id, key), 400);
    },
    [fetchPreview, fileKey],
  );

  // Plain row click → single selection (replaces the current set).
  const selectNode = useCallback(
    (n: TreeNode) => {
      setActiveId(n.id);
      setSelectedIds(new Set([n.id]));
      queuePreview(n.id);
    },
    [queuePreview],
  );

  // Checkbox → add/remove from the multi-selection.
  const toggleNode = useCallback(
    (n: TreeNode) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(n.id)) next.delete(n.id);
        else next.add(n.id);
        return next;
      });
      setActiveId(n.id);
      queuePreview(n.id);
    },
    [queuePreview],
  );

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    setTree(null);
    setActiveId(null);
    setSelectedIds(new Set());
    setVariables([]);
    setPreviewUrl(null);
    previewCache.current.clear();
    localStorage.setItem("figma-token", token);
    localStorage.setItem("figma-url", url);
    try {
      const res = await fetch("/api/figma/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ошибка загрузки");
      setFileKey(data.fileKey);
      setFileName(data.fileName);
      setTree(data.tree);
      setRootNode(data.node);
      setActiveId(data.rootId);
      setSelectedIds(new Set([data.rootId]));
      fetchPreview(data.rootId, data.fileKey);
      const entry: HistoryEntry = {
        fileKey: data.fileKey,
        fileName: data.fileName,
        url,
        source: "rest",
        savedAt: Date.now(),
        node: data.node,
        tree: data.tree,
      };
      setHistory((h) => saveHistory(entry, h));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, url, fetchPreview]);

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2.5">
        <div className="flex items-center gap-2 pr-1">
          <span className="text-lg">🎨</span>
          <span className="font-semibold">Figma Copy</span>
        </div>

        {/* Input source switch */}
        <div className="flex overflow-hidden rounded-md border border-border">
          {(
            [
              ["rest", "Токен"],
              ["plugin", "Плагин"],
            ] as ["rest" | "plugin", string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setInputMode(m)}
              className={`px-2.5 py-1.5 text-xs font-semibold ${
                inputMode === m
                  ? "bg-accent text-white"
                  : "text-foreground/50 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Recently loaded files — restore instantly from local cache */}
        <div className="relative">
          <button
            onClick={() => setShowHistory((v) => !v)}
            disabled={!history.length}
            title="Недавно загруженные файлы (из локального кэша)"
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground/60 hover:text-foreground disabled:opacity-30"
          >
            История {history.length ? `(${history.length})` : ""}
          </button>
          {showHistory && history.length > 0 && (
            <div className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-panel shadow-xl">
              {history.map((e) => (
                <div
                  key={e.fileKey}
                  className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-sm last:border-0 hover:bg-white/5"
                >
                  <button
                    onClick={() => restoreEntry(e)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate font-medium">{e.fileName}</div>
                    <div className="text-[11px] text-foreground/40">
                      {e.source === "plugin" ? "плагин" : "токен"} ·{" "}
                      {new Date(e.savedAt).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </button>
                  <button
                    onClick={() => setHistory((h) => removeHistory(e.fileKey, h))}
                    title="Убрать из истории"
                    className="shrink-0 text-foreground/30 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {inputMode === "rest" ? (
          <>
            <input
              type="password"
              placeholder="Figma personal access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <input
              type="text"
              placeholder="Ссылка на Figma-файл (с ?node-id=… для блока)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={load}
              disabled={loading || !token || !url}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {loading ? "Загрузка…" : "Загрузить"}
            </button>
            <a
              href="https://www.figma.com/developers/api#access-tokens"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-foreground/40 hover:text-foreground/70"
              title="Где взять токен"
            >
              токен?
            </a>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                pluginConnected ? "bg-green-400" : "bg-foreground/30"
              }`}
            />
            <span className="text-foreground/60">
              {pluginConnected ? "Жду данные из плагина" : "Подключение…"}
            </span>
            <span className="truncate text-xs text-foreground/40">
              — откройте плагин «Figma Copy — Send to app» в Figma, выделите блок
              и нажмите «Отправить выбранное».
            </span>
          </div>
        )}
      </header>

      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Body: 3 columns */}
      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_1fr]">
        {/* Layers */}
        <aside className="flex min-h-0 flex-col border-r border-border bg-panel">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
            {fileName ? fileName : "Слои"}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <LayerTree
              tree={tree}
              activeId={activeId}
              selectedIds={selectedIds}
              onSelect={selectNode}
              onToggle={toggleNode}
            />
          </div>
        </aside>

        {/* Preview */}
        <section className="min-h-0 border-r border-border">
          <PreviewPanel
            imageUrl={previewUrl}
            html={previewHtml}
            loading={previewLoading}
            theme={converted?.previewTheme ?? null}
          />
        </section>

        {/* Code / Tokens */}
        <section className="flex min-h-0 flex-col bg-panel">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
            {(
              [
                ["code", "Код"],
                ["tokens", "Дизайн-токены"],
              ] as ["code" | "tokens", string][]
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setRightTab(t)}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${
                  rightTab === t
                    ? "bg-accent text-white"
                    : "text-foreground/50 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}

            {rightTab === "code" && (
              <>
                <button
                  onClick={() => setUseTokens((v) => !v)}
                  title="Использовать токены палитры (bg-purple-500) вместо хексов"
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${
                    useTokens
                      ? "border-accent bg-accent/20 text-white"
                      : "border-border text-foreground/50 hover:text-foreground"
                  }`}
                >
                  Токены в коде
                </button>
                <button
                  onClick={() => setSemantic((v) => !v)}
                  title="Семантические теги: button / h1-h6 / a вместо div/p"
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${
                    semantic
                      ? "border-accent bg-accent/20 text-white"
                      : "border-border text-foreground/50 hover:text-foreground"
                  }`}
                >
                  Семантика
                </button>
                <button
                  onClick={() => setInferLayout((v) => !v)}
                  title="Превращать распознанный авто-лейаут в flex вместо absolute (может изменить структуру)"
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${
                    inferLayout
                      ? "border-accent bg-accent/20 text-white"
                      : "border-border text-foreground/50 hover:text-foreground"
                  }`}
                >
                  Авто-flex
                </button>
                <button
                  onClick={() => setResponsive((v) => !v)}
                  title="Флюидный корень: w-full + max-w вместо фикс-ширины, чтобы блок адаптировался к узким экранам"
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${
                    responsive
                      ? "border-accent bg-accent/20 text-white"
                      : "border-border text-foreground/50 hover:text-foreground"
                  }`}
                >
                  Адаптив
                </button>
              </>
            )}

            {selectedNodes.length > 1 && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-foreground/50">
                  Выбрано: {selectedNodes.length}
                </span>
                <div className="flex overflow-hidden rounded border border-border">
                  {(
                    [
                      ["combine", "Собрать"],
                      ["separate", "Отдельно"],
                    ] as ["combine" | "separate", string][]
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      onClick={() => setMultiMode(m)}
                      className={`px-2 py-0.5 text-xs font-medium ${
                        multiMode === m
                          ? "bg-accent text-white"
                          : "text-foreground/50 hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {rightTab === "code" && converted?.warnings?.length ? (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500/90">
              <span className="font-medium">Предупреждения конвертации:</span>{" "}
              {converted.warnings.join("; ")}
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            {rightTab === "code" ? (
              <CodePanel
                reactCode={reactCode}
                htmlCode={htmlCode}
                vueCode={vueCode}
                cssJsx={cssJsx}
                cssText={cssText}
                onHtmlEdit={handleHtmlEdit}
                onResetHtml={resetHtml}
                htmlEdited={htmlIsEdited}
                onDownloadZip={downloadZip}
                canExport={!!converted}
              />
            ) : (
              <TokensPanel node={tokenNode} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
