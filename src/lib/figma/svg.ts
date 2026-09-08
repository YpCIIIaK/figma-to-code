/**
 * Clean-up for the SVG markup Figma exports, shared by the REST route and (in
 * spirit — it is a standalone sandbox script) the plugin UI.
 */

/**
 * Trim Figma's XML preamble and the root width/height so our CSS controls
 * sizing. The size attributes are stripped from the <svg> tag ONLY: Figma's
 * exports carry inner <mask>/<rect> elements sized by those very attributes,
 * and clearing them collapses the mask to zero area — the whole drawing then
 * renders as nothing.
 */
export function sanitizeSvg(raw: string): string {
  return raw
    .replace(/<\?xml[^>]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg\b[^>]*>/i, (tag) => tag.replace(/\s(width|height)="[^"]*"/gi, ""))
    .trim();
}

/** SVG markup past this size is never worth inlining as a data URI. */
export const SVG_MAX_CHARS = 96 * 1024;

/** True when an SVG embeds a raster or is simply too big to inline. */
export function isBloatedSvg(markup: string): boolean {
  return markup.length > SVG_MAX_CHARS || markup.includes("data:image/");
}
