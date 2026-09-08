import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The plugin runs in Figma's sandbox, so it is a plain script rather than a
 * module. Loading it here with a stubbed `figma` global lets us test the parts
 * that mirror the converter — drift between the two mirrors has bitten us
 * before (a node the plugin never exports renders as an empty box).
 */
function loadPlugin() {
  const src = readFileSync("figma-plugin/code.js", "utf8");
  const noop = () => {};
  const figma = {
    showUI: noop,
    on: noop,
    mixed: Symbol("mixed"),
    clientStorage: { getAsync: () => Promise.resolve(null), setAsync: noop },
    ui: { postMessage: noop, onmessage: null },
    currentPage: { selection: [] },
  };
  return new Function(
    "figma",
    "__html__",
    src + "\n;return { restType, isIconNode, isTextRing, isSplitGlyphText, collectAssets };",
  )(figma, "");
}

describe("figma plugin", () => {
  const plugin = loadPlugin();

  it("renames plugin-only node types to their REST equivalents", () => {
    // A triangle is POLYGON in the Plugin API, REGULAR_POLYGON over REST.
    // Untranslated it misses VECTOR_TYPES and renders as a filled square.
    expect(plugin.restType("POLYGON")).toBe("REGULAR_POLYGON");
    expect(plugin.restType("TRANSFORM_GROUP")).toBe("GROUP");
    expect(plugin.restType("TEXT_PATH")).toBe("VECTOR");
    expect(plugin.restType("RECTANGLE")).toBe("RECTANGLE");
  });

  it("treats a REST-named polygon as an icon to export", () => {
    expect(plugin.isIconNode({ type: "REGULAR_POLYGON", name: "Arrow" })).toBe(true);
  });

  it("does not flatten a section that merely contains rotated labels", () => {
    const section = {
      type: "FRAME",
      name: "Секция",
      absoluteBoundingBox: { x: 0, y: 0, width: 1340, height: 700 },
      children: [
        { type: "FRAME", name: "inner", children: [] },
        { type: "TEXT", name: "t", characters: "Заголовок", rotation: 30 },
      ],
    };
    expect(plugin.isTextRing(section)).toBe(false);
    expect(plugin.isIconNode(section)).toBe(false);
  });

  it("exports a raster-masked group as PNG, matching what the markup asks for", () => {
    // The converter emits <img src=png[id]> for a mask over a photo. Exporting
    // it as SVG here would file the bytes under assets.svg and the picture
    // would render with an empty src — every map pin a broken image.
    const pin = {
      id: "1:1",
      type: "GROUP",
      name: "Mask group",
      children: [
        { id: "1:2", type: "RECTANGLE", name: "mask", isMask: true, fills: [{ type: "IMAGE" }] },
        { id: "1:3", type: "RECTANGLE", name: "fill", fills: [{ type: "SOLID" }] },
      ],
    };
    const acc: { id: string; kind: string }[] = [];
    plugin.collectAssets(pin, acc);
    expect(acc).toEqual([{ id: "1:1", kind: "png" }]);
  });

  it("still exports a purely vector icon as SVG", () => {
    const acc: { id: string; kind: string }[] = [];
    plugin.collectAssets({ id: "2:1", type: "VECTOR", name: "Arrow" }, acc);
    expect(acc).toEqual([{ id: "2:1", kind: "svg" }]);
  });

  it("flattens a word split into per-glyph text nodes", () => {
    const ring = {
      type: "GROUP",
      name: "Linked Path Group",
      children: "ЛОКАЛЬНОЕ".split("").map((ch) => ({ type: "TEXT", name: ch, characters: ch })),
    };
    expect(plugin.isSplitGlyphText(ring)).toBe(true);
    expect(plugin.isIconNode(ring)).toBe(true);
  });
});
