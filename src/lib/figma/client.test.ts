import { describe, it, expect } from "vitest";
import { normalizeRotation } from "./client";
import type { FigmaNode } from "./types";

describe("REST payload normalisation", () => {
  it("converts REST radians (CCW) into CSS degrees (CW), recursively", () => {
    const root = {
      id: "1",
      name: "root",
      type: "FRAME",
      rotation: Math.PI / 4,
      children: [
        { id: "2", name: "a", type: "RECTANGLE", rotation: -Math.PI / 2 },
        { id: "3", name: "b", type: "RECTANGLE" },
      ],
    } as unknown as FigmaNode;
    normalizeRotation(root);
    expect(root.rotation).toBeCloseTo(-45, 6);
    expect(root.children![0].rotation).toBeCloseTo(90, 6);
    expect(root.children![1].rotation).toBeUndefined();
  });
});
