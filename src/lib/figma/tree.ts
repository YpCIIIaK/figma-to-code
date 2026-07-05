import type { FigmaNode, TreeNode } from "./types";

/** Build a trimmed tree (id/name/type only) for the layer panel. */
export function toTree(node: FigmaNode, maxDepth = 6): TreeNode {
  const walk = (n: FigmaNode, depth: number): TreeNode => ({
    id: n.id,
    name: n.name,
    type: n.type,
    children:
      depth < maxDepth && n.children?.length
        ? n.children
            .filter((c) => c.visible !== false)
            .map((c) => walk(c, depth + 1))
        : undefined,
  });
  return walk(node, 0);
}

/** Find a node by id anywhere in a Figma subtree. */
export function findNode(node: FigmaNode, id: string): FigmaNode | null {
  if (node.id === id) return node;
  if (node.children) {
    for (const c of node.children) {
      const found = findNode(c, id);
      if (found) return found;
    }
  }
  return null;
}
