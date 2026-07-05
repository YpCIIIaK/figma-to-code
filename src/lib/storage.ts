// Local persistence: per-node HTML edits + recently loaded files (so a file can
// be restored instantly without hitting the Figma REST API again).

import type { FigmaNode, TreeNode, VarToken } from "./figma/types";

// ---------------- Per-node HTML edits ----------------

const EDITS_KEY = "figma-copy-edits";

export function loadEdits(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(EDITS_KEY) || "{}");
  } catch {
    return {};
  }
}

function persistEdits(edits: Record<string, string>) {
  try {
    localStorage.setItem(EDITS_KEY, JSON.stringify(edits));
  } catch {
    /* quota — keep edits in memory only */
  }
}

export function saveEdit(
  edits: Record<string, string>,
  key: string,
  html: string,
): void {
  edits[key] = html;
  persistEdits(edits);
}

export function deleteEdit(edits: Record<string, string>, key: string): void {
  delete edits[key];
  persistEdits(edits);
}

// ---------------- Recently loaded files ----------------

export interface HistoryEntry {
  fileKey: string;
  fileName: string;
  url?: string;
  source: "rest" | "plugin";
  savedAt: number;
  node: FigmaNode;
  tree: TreeNode;
  /** Design-system variables captured from the plugin payload (if any). */
  variables?: VarToken[];
}

const HISTORY_KEY = "figma-copy-history";
const HISTORY_MAX = 8;

export function loadHistory(): HistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Prepend an entry (de-duped by fileKey), cap the list, persist with a
 * quota-safe retry that drops the oldest entries until it fits. */
export function saveHistory(
  entry: HistoryEntry,
  current: HistoryEntry[],
): HistoryEntry[] {
  let list = [entry, ...current.filter((e) => e.fileKey !== entry.fileKey)];
  list = list.slice(0, HISTORY_MAX);
  while (list.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      break;
    } catch {
      list = list.slice(0, list.length - 1); // too big — drop the oldest
    }
  }
  return list;
}

export function removeHistory(
  fileKey: string,
  current: HistoryEntry[],
): HistoryEntry[] {
  const list = current.filter((e) => e.fileKey !== fileKey);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
