import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeSvg, isBloatedSvg } from "./svg";

/** The plugin UI carries its own copy (sandbox script) — keep them in step. */
function pluginSanitizeSvg(): (raw: string) => string {
  const html = readFileSync("figma-plugin/ui.html", "utf8");
  const src = /function sanitizeSvg\(raw\) \{[\s\S]*?\n      \}/.exec(html);
  if (!src) throw new Error("sanitizeSvg not found in ui.html");
  return new Function("return " + src[0])();
}

// A Figma area-chart export: the drawing lives inside a masked group, and the
// mask is a <rect> sized purely by width/height.
const CHART = `<?xml version="1.0"?>
<svg width="940" height="369" viewBox="0 0 940 369" fill="none" xmlns="http://www.w3.org/2000/svg">
<mask id="m0" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="940" height="369">
<rect width="940" height="369" fill="#D9D9D9"/>
</mask>
<g mask="url(#m0)">
<path d="M165 15L83 281Z" fill="#CB4E00"/>
</g>
</svg>`;

describe.each([
  ["app", sanitizeSvg],
  ["plugin", pluginSanitizeSvg()],
])("sanitizeSvg (%s copy)", (_name, clean) => {
  it("keeps the mask's dimensions so the drawing is not clipped away", () => {
    const out = clean(CHART);
    // Stripping these globally collapses the mask to zero area and the whole
    // chart renders as an empty box.
    expect(out).toContain('<rect width="940" height="369" fill="#D9D9D9"/>');
    expect(out).toContain('maskUnits="userSpaceOnUse" x="0" y="0" width="940" height="369"');
  });

  it("still drops the root size so CSS controls it", () => {
    const out = clean(CHART);
    const root = /<svg\b[^>]*>/.exec(out)![0];
    expect(root).not.toContain("width=");
    expect(root).not.toContain("height=");
    expect(root).toContain('viewBox="0 0 940 369"');
  });

  it("drops the XML preamble and comments", () => {
    expect(clean(CHART)).not.toContain("<?xml");
    expect(clean("<!-- note --><svg></svg>")).toBe("<svg></svg>");
  });
});

describe("isBloatedSvg", () => {
  it("flags an embedded raster and oversized markup", () => {
    expect(isBloatedSvg('<svg><image href="data:image/png;base64,AAA"/></svg>')).toBe(true);
    expect(isBloatedSvg("<svg>" + "x".repeat(100 * 1024) + "</svg>")).toBe(true);
    expect(isBloatedSvg("<svg><path d=\"M0 0\"/></svg>")).toBe(false);
  });
});
