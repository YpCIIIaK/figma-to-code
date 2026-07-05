"use client";

import { useMemo, useState } from "react";
import {
  extractTokens,
  isEmptyTokens,
  serializeTokens,
  type TokenFormat,
} from "@/lib/figma/tokens";
import type { FigmaNode } from "@/lib/figma/types";

type View = "visual" | "css" | "tailwind" | "json";

export default function TokensPanel({ node }: { node: FigmaNode | null }) {
  const [view, setView] = useState<View>("visual");
  const [copied, setCopied] = useState(false);

  const tokens = useMemo(() => (node ? extractTokens(node) : null), [node]);

  const code = useMemo(() => {
    if (!tokens || view === "visual") return "";
    return serializeTokens(tokens, view as TokenFormat);
  }, [tokens, view]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const empty = !tokens || isEmptyTokens(tokens);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex gap-1">
          {(
            [
              ["visual", "Палитра"],
              ["css", "CSS"],
              ["tailwind", "Tailwind v4"],
              ["json", "JSON"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                view === v
                  ? "bg-white/10 text-white"
                  : "text-foreground/50 hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {view !== "visual" && (
          <button
            onClick={copy}
            disabled={!code}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white disabled:opacity-30"
          >
            {copied ? "Скопировано ✓" : "Копировать"}
          </button>
        )}
      </div>

      {empty ? (
        <div className="flex h-full items-center justify-center text-sm text-foreground/40">
          {node ? "В этом блоке нет токенов." : "Выберите блок в дереве слоёв."}
        </div>
      ) : view === "visual" ? (
        <VisualTokens tokens={tokens!} />
      ) : (
        <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-foreground/90">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (!count) return null;
  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">
        {title} <span className="text-foreground/30">· {count}</span>
      </div>
      {children}
    </div>
  );
}

function VisualTokens({
  tokens,
}: {
  tokens: NonNullable<ReturnType<typeof extractTokens>>;
}) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <Group title="Цвета" count={tokens.colors.length}>
        <div className="grid grid-cols-2 gap-2">
          {tokens.colors.map((c) => (
            <div
              key={c.value}
              className="flex items-center gap-2 rounded-md border border-border bg-background/40 p-1.5"
            >
              <span
                className="h-8 w-8 shrink-0 rounded border border-border"
                style={{ background: c.value }}
              />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{c.name}</div>
                <div className="truncate font-mono text-[11px] text-foreground/50">
                  {c.value}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Group>

      <Group title="Типографика" count={tokens.typography.length}>
        <div className="flex flex-col gap-2">
          {tokens.typography.map((t) => (
            <div
              key={t.name}
              className="rounded-md border border-border bg-background/40 p-2"
            >
              <div
                className="truncate text-foreground"
                style={{
                  fontFamily: t.fontFamily,
                  fontSize: Math.min(t.fontSize ?? 14, 28),
                  fontWeight: t.fontWeight,
                }}
              >
                {t.fontFamily ?? "Text"} {t.fontSize}px
              </div>
              <div className="mt-1 font-mono text-[11px] text-foreground/50">
                {t.fontSize}px · {t.fontWeight ?? "400"}
                {t.lineHeightPx ? ` · lh ${Math.round(t.lineHeightPx)}px` : ""}
              </div>
            </div>
          ))}
        </div>
      </Group>

      <Group title="Шрифты" count={tokens.fontFamilies.length}>
        <div className="flex flex-wrap gap-2">
          {tokens.fontFamilies.map((f) => (
            <span
              key={f.value}
              className="rounded-md border border-border bg-background/40 px-2 py-1 text-xs"
              style={{ fontFamily: f.value }}
            >
              {f.value}
            </span>
          ))}
        </div>
      </Group>

      <Group title="Отступы" count={tokens.spacing.length}>
        <div className="flex flex-wrap gap-2">
          {tokens.spacing.map((s) => (
            <span
              key={s.value}
              className="rounded-md border border-border bg-background/40 px-2 py-1 font-mono text-xs text-foreground/70"
            >
              {s.value}px
            </span>
          ))}
        </div>
      </Group>

      <Group title="Скругления" count={tokens.radii.length}>
        <div className="flex flex-wrap gap-2">
          {tokens.radii.map((s) => (
            <span
              key={s.value}
              className="rounded-md border border-border bg-background/40 px-2 py-1 font-mono text-xs text-foreground/70"
            >
              {s.value}px
            </span>
          ))}
        </div>
      </Group>

      <Group title="Тени" count={tokens.shadows.length}>
        <div className="flex flex-col gap-2">
          {tokens.shadows.map((s) => (
            <div
              key={s.value}
              className="flex items-center gap-3 rounded-md border border-border bg-background/40 p-2"
            >
              <span
                className="h-8 w-8 shrink-0 rounded bg-white"
                style={{ boxShadow: s.value }}
              />
              <span className="truncate font-mono text-[11px] text-foreground/60">
                {s.value}
              </span>
            </div>
          ))}
        </div>
      </Group>
    </div>
  );
}
