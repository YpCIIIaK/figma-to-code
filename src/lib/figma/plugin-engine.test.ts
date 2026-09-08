import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generate } from "./generate";
import type { FigmaNode } from "./types";

/**
 * The plugin carries a bundled copy of the engine so it can generate code with
 * no server running. A stale bundle would silently serve different output than
 * /api/convert, so run the committed bundle here and compare.
 */
function pluginEngine(): { convert: (b: unknown) => { react?: string; error?: string } } {
  const html = readFileSync("figma-plugin/ui.html", "utf8");
  const start = html.indexOf("<!-- ENGINE:START -->");
  const end = html.indexOf("<!-- ENGINE:END -->");
  if (start < 0 || end < 0) throw new Error("engine markers missing from ui.html");
  const block = html.slice(start, end);
  const code = /<script>([\s\S]*)<\/script>/.exec(block);
  if (!code) throw new Error("engine bundle missing — run `npm run build:plugin`");
  // The bundle assigns globalThis.FigmaCopyEngine; hand it a scope of its own.
  const scope: Record<string, unknown> = {};
  new Function("globalThis", code[1])(scope);
  return scope.FigmaCopyEngine as ReturnType<typeof pluginEngine>;
}

const NODE: FigmaNode = {
  id: "1:1",
  name: "Card",
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
  fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
  children: [
    {
      id: "1:2",
      name: "Title",
      type: "TEXT",
      characters: "Привет",
      absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 20 },
      style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16 },
    } as FigmaNode,
  ],
} as FigmaNode;

describe("bundled plugin engine", () => {
  it("produces byte-identical output to the server path", () => {
    const body = { node: NODE, semantic: true };
    const fromPlugin = pluginEngine().convert(structuredClone(body));
    const fromServer = generate(structuredClone(body));
    expect(fromPlugin).toEqual(fromServer);
  });

  it("reports a bad payload instead of throwing", () => {
    const res = pluginEngine().convert({});
    expect(res.error).toBeTruthy();
  });
});
