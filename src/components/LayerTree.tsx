"use client";

import { useState } from "react";
import type { TreeNode } from "@/lib/figma/types";

const TYPE_ICON: Record<string, string> = {
  FRAME: "▢",
  GROUP: "⊞",
  COMPONENT: "◇",
  INSTANCE: "◆",
  TEXT: "T",
  RECTANGLE: "▭",
  ELLIPSE: "◯",
  VECTOR: "✎",
  CANVAS: "▦",
  LINE: "─",
};

function Row({
  node,
  depth,
  activeId,
  selectedIds,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  activeId: string | null;
  selectedIds: Set<string>;
  onSelect: (n: TreeNode) => void;
  onToggle: (n: TreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = !!node.children?.length;
  const active = node.id === activeId;
  const checked = selectedIds.has(node.id);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded px-1.5 py-1 text-sm cursor-pointer select-none ${
          active
            ? "bg-accent/25 text-white"
            : checked
              ? "bg-accent/10"
              : "hover:bg-white/5"
        }`}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => onSelect(node)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className={`w-4 shrink-0 text-xs text-foreground/40 ${
            hasChildren ? "" : "invisible"
          }`}
        >
          {open ? "▾" : "▸"}
        </button>
        <input
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggle(node)}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
          title="Добавить к выбору"
        />
        <span className="w-4 shrink-0 text-center text-xs text-foreground/50">
          {TYPE_ICON[node.type] ?? "•"}
        </span>
        <span className="truncate">{node.name}</span>
      </div>
      {open &&
        node.children?.map((c) => (
          <Row
            key={c.id}
            node={c}
            depth={depth + 1}
            activeId={activeId}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

export default function LayerTree({
  tree,
  activeId,
  selectedIds,
  onSelect,
  onToggle,
}: {
  tree: TreeNode | null;
  activeId: string | null;
  selectedIds: Set<string>;
  onSelect: (n: TreeNode) => void;
  onToggle: (n: TreeNode) => void;
}) {
  if (!tree)
    return (
      <div className="p-4 text-sm text-foreground/40">
        Загрузите файл, чтобы увидеть слои.
      </div>
    );
  return (
    <div className="p-1">
      <Row
        node={tree}
        depth={0}
        activeId={activeId}
        selectedIds={selectedIds}
        onSelect={onSelect}
        onToggle={onToggle}
      />
    </div>
  );
}
