import type {
  FigmaNode,
  FigmaColor,
  FigmaPaint,
  FigmaRect,
  VarToken,
} from "./types";
import { extractTokens } from "./tokens";

/** A Figma node that must be exported as an image asset (icon or photo). */
export interface AssetRef {
  id: string;
  kind: "svg" | "png";
  className: string;
  /** source layer name — used to name the file when assets are emitted as paths */
  name?: string;
}

type IRTag =
  | "div"
  | "span"
  | "p"
  | "img"
  | "button"
  | "a"
  | "ul"
  | "li"
  | "nav"
  | "header"
  | "footer"
  | "main"
  | "section"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6";

/** Intermediate element produced from a Figma node before serialization. */
interface IRElement {
  tag: IRTag;
  classes: string[];
  text?: string;
  /** inline styles we can't cleanly express as Tailwind utilities */
  style: Record<string, string>;
  children: IRElement[];
  name: string;
  /** extra HTML attributes (e.g. type="button", href="#") */
  attrs?: Record<string, string>;
  /** JSX-only: render `{propName}` instead of literal text (component prop) */
  textProp?: string;
  /** JSX-only: wrap the element in `{propName && (...)}` (BOOLEAN component prop) */
  condProp?: string;
  /** JSX-only: replace the whole element with `{propName}` (INSTANCE_SWAP slot) */
  slotProp?: string;
  /** set when this element is an exported asset (icon/image) */
  asset?: { id: string; kind: "svg" | "png" };
  /** set when we draw the shape ourselves (arc / donut segment) */
  svg?: { viewBox: string; shapes: SvgShape[] };
}

/** One drawn path inside a generated <svg> (see arcShapes). */
interface SvgShape {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** round caps — a ring segment drawn as a stroked centreline (see arcShapes) */
  linecap?: "round";
}

export interface ConvertOptions {
  /** absolutely position children of non-auto-layout frames */
  absolutePositioning?: boolean;
  /** emit semantic token utilities (bg-purple-500, font-inter) instead of hex */
  useTokens?: boolean;
  /** emit semantic tags (button / h1-h6 / a) instead of plain div/p */
  semantic?: boolean;
  /** turn Figma's inferred auto-layout on free-form frames into flex (opt-in) */
  inferLayout?: boolean;
  /** make the root block fluid: w-full + max-w instead of a hard pixel width */
  responsive?: boolean;
  /** design-system variables (from the Figma plugin) → real token names */
  variables?: VarToken[];
  /** internal: value→token-name maps, built once per conversion */
  tokens?: TokenMaps;
  /** internal: palette/fonts, threaded down so CSS-modules resolve token names */
  previewTheme?: PreviewTheme;
  /** internal: sanitized names of the root component's generated props */
  propNames?: Set<string>;
  /** internal: distinct text font sizes in the tree (desc), for relative headings */
  textSizes?: number[];
  /** annotate every block with its Figma layer / style name (data-name, data-style) */
  layerNames?: boolean;
  /** internal: shared sink for conversion warnings (lossy / unsupported cases) */
  warnings?: string[];
}

interface TokenMaps {
  /** color value ("#7c6cff" / "rgba(...)") → token name ("purple-500") */
  color: Map<string, string>;
  /** font family ("Inter") → token name ("inter") */
  font: Map<string, string>;
}

/** Theme data the live preview injects into the Tailwind CDN config. */
export interface PreviewTheme {
  colors: Record<string, string>;
  fontFamily: Record<string, string[]>;
  /** Spacing / radius / font-size tokens from Figma variables (name → value). */
  spacing?: Record<string, string>;
  borderRadius?: Record<string, string>;
  fontSize?: Record<string, string>;
}

interface TokenContext {
  maps: TokenMaps;
  themeCss: string;
  previewTheme: PreviewTheme;
}

/** Extract the palette/fonts of a node and shape them for token-aware codegen. */
function buildTokenContext(node: FigmaNode, variables?: VarToken[]): TokenContext {
  const set = extractTokens(node);
  const color = new Map(set.colors.map((c) => [c.value, c.name]));
  const font = new Map(set.fontFamilies.map((f) => [f.value, f.name]));

  const lines: string[] = [];
  for (const c of set.colors) lines.push(`  --color-${c.name}: ${c.value};`);
  for (const f of set.fontFamilies)
    lines.push(`  --font-${f.name}: "${f.value}", sans-serif;`);

  const previewTheme: PreviewTheme = {
    colors: Object.fromEntries(set.colors.map((c) => [c.name, c.value])),
    fontFamily: Object.fromEntries(
      set.fontFamilies.map((f) => [f.name, [f.value, "sans-serif"]]),
    ),
    spacing: {},
    borderRadius: {},
    fontSize: {},
  };

  // Real design-system variables (color/primary/500, spacing/md) take priority
  // over the hue/px names we synthesize — they carry the designer's intent.
  const seen = new Set(set.colors.map((c) => c.name));
  for (const v of variables ?? []) {
    if (v.kind === "color") {
      // Seed value→name so the same colour resolves to this token everywhere.
      if (!color.has(v.value)) color.set(v.value, v.name);
      if (!previewTheme.colors[v.name]) {
        previewTheme.colors[v.name] = v.value;
        if (!seen.has(v.name)) {
          lines.push(`  --color-${v.name}: ${v.value};`);
          seen.add(v.name);
        }
      }
    } else if (v.kind === "space") {
      previewTheme.spacing![v.name] = v.value;
      lines.push(`  --spacing-${v.name}: ${v.value};`);
    } else if (v.kind === "radius") {
      previewTheme.borderRadius![v.name] = v.value;
      lines.push(`  --radius-${v.name}: ${v.value};`);
    } else if (v.kind === "size") {
      previewTheme.fontSize![v.name] = v.value;
      lines.push(`  --text-${v.name}: ${v.value};`);
    }
  }

  const themeCss = lines.length ? `@theme {\n${lines.join("\n")}\n}\n` : "";
  return { maps: { color, font }, themeCss, previewTheme };
}

/**
 * `bg-primary-500` when the paint is bound to a Figma variable, `bg-purple-500`
 * for a recognised palette token, else the raw `bg-[#7c6cff]`.
 */
function colorClass(
  prefix: string,
  value: string,
  maps?: TokenMaps,
  variableName?: string,
): string {
  // Only emit a bare token class (text-primary / bg-white) in token mode, where
  // the matching @theme is injected. Without it the class resolves to nothing
  // and the element renders with no colour — fall back to the raw hex instead.
  if (variableName && maps) return `${prefix}-${variableName}`;
  const name = maps?.color.get(value);
  return name ? `${prefix}-${name}` : `${prefix}-[${value}]`;
}

const VECTOR_TYPES = new Set([
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "REGULAR_POLYGON",
  "LINE",
]);

function subtreeHasText(n: FigmaNode): boolean {
  if (n.type === "TEXT") return true;
  return (n.children ?? []).some(subtreeHasText);
}

/**
 * Text that a reader is meant to select and search: upright, and not a single
 * decorative glyph. Rotated ring labels don't count — those only survive as a
 * flattened SVG anyway.
 */
function subtreeHasRealText(n: FigmaNode): boolean {
  if (
    n.type === "TEXT" &&
    Math.abs(n.rotation ?? 0) <= 10 &&
    !isCurvedTextNode(n) &&
    (n.characters ?? "").trim().length > 1
  )
    return true;
  return (n.children ?? []).some(subtreeHasRealText);
}

/**
 * A single TEXT node bent along a path (Figma Draw "text on a path"). CSS
 * can't curve text, so it must flatten into one SVG asset. The plugin marks it
 * (svgExport); for REST payloads fall back to geometry — a straight text block
 * is ~lines × lineHeight tall, while path text (a ring is roughly square) is
 * far taller than any line count explains.
 */
function isCurvedTextNode(n: FigmaNode): boolean {
  if (n.type !== "TEXT") return false;
  if (n.svgExport) return true;
  const box = n.absoluteBoundingBox;
  const chars = n.characters ?? "";
  if (!box || !box.width || !box.height || !chars) return false;
  const fs = n.style?.fontSize ?? 14;
  const lineH = fs * 1.5;
  // Worst-case (largest) line-count estimate for box-width wrapping.
  const perLine = Math.max(1, Math.floor(box.width / (fs * 0.55)));
  let lines = 0;
  for (const part of chars.split("\n"))
    lines += Math.max(1, Math.ceil(part.length / perLine));
  return box.height > Math.max(lineH, lines * lineH) * 2.2;
}

/**
 * Text bent around a circle: each letter/word is its own rotated TEXT node.
 * CSS has no text-on-path, so the only faithful output is one flattened SVG.
 *
 * The test must stay *tight*: a whole section that happens to contain a ringed
 * chart label would otherwise collapse into a single image, taking every real
 * heading and paragraph with it. So we demand the geometry of an actual ring —
 * a roughly square box, short labels, and centres at a consistent radius.
 */
function isTextRing(n: FigmaNode): boolean {
  const texts: FigmaNode[] = [];
  (function walk(m: FigmaNode) {
    if (m.type === "TEXT") texts.push(m);
    for (const c of m.children ?? []) walk(c);
  })(n);
  // A ring is a flat bag of glyph/word layers. Anything whose children are
  // frames is a section that merely *contains* a ring — flattening it would
  // turn the whole layout into one picture.
  const kids = n.children ?? [];
  if (!kids.length || !kids.every((c) => c.type === "TEXT")) return false;
  if (texts.length < 3 || texts.length > 80) return false;
  const rotated = texts.filter((t) => Math.abs(t.rotation ?? 0) > 10);
  if (rotated.length < texts.length * 0.6) return false;
  // Ring labels are short — a wrapped paragraph that merely sits at an angle
  // is still ordinary text.
  if (rotated.some((t) => (t.characters ?? "").length > 40)) return false;
  const box = n.absoluteBoundingBox;
  if (!box || !box.width || !box.height) return false;
  const aspect = box.width / box.height;
  if (aspect < 0.5 || aspect > 2) return false;
  // Every rotated label must sit at roughly the same distance from the centre.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radii: number[] = [];
  for (const t of rotated) {
    const b = t.absoluteBoundingBox;
    if (!b) return false;
    const dx = b.x + b.width / 2 - cx;
    const dy = b.y + b.height / 2 - cy;
    radii.push(Math.sqrt(dx * dx + dy * dy));
  }
  const max = Math.max(...radii);
  const min = Math.min(...radii);
  return max > 0 && min >= max * 0.5;
}

/**
 * A word laid out on a path: Figma splits it into one TEXT node per glyph.
 * Rotation is no help — along a gentle arc each letter is tilted a degree or
 * two — but no hand-built layout ever splits a word into single-character
 * layers, so the shape of the children is the giveaway. Left as HTML it
 * explodes into dozens of absolutely-positioned <p>s that never line up.
 */
function isSplitGlyphText(n: FigmaNode): boolean {
  const kids = n.children ?? [];
  if (kids.length < 5) return false;
  if (!kids.every((c) => c.type === "TEXT")) return false;
  const glyphs = kids.filter((c) => (c.characters ?? "").trim().length <= 2);
  return glyphs.length >= kids.length * 0.8;
}

/** Does this container hold a mask layer (which clips its later siblings)? */
function hasMaskedChild(n: FigmaNode): boolean {
  return (n.children ?? []).some((c) => c.isMask);
}

function subtreeHasVector(n: FigmaNode): boolean {
  if (VECTOR_TYPES.has(n.type)) return true;
  return (n.children ?? []).some(subtreeHasVector);
}

/** Partial ellipse (arc / donut / crescent) — CSS can't draw it, export SVG. */
function isArcEllipse(n: FigmaNode): boolean {
  if (n.type !== "ELLIPSE" || !n.arcData) return false;
  const a = n.arcData;
  const full = Math.abs(a.endingAngle - a.startingAngle) >= Math.PI * 2 - 0.001;
  return !full || a.innerRadius > 0;
}

/** A node we should export as a single SVG (an icon / illustration). */
function isIconNode(n: FigmaNode): boolean {
  if (VECTOR_TYPES.has(n.type)) return true;
  if (isArcEllipse(n)) return true;
  const container =
    n.type === "FRAME" ||
    n.type === "GROUP" ||
    n.type === "INSTANCE" ||
    n.type === "COMPONENT";
  // Honour an explicit "Export as SVG" mark from the designer — but never for a
  // photo container (that would embed the raster and bloat the output), and
  // never for a container full of real text: designers routinely leave export
  // settings on a whole section, and obeying that turns the section into one
  // flat picture with no selectable text left.
  if (n.svgExport && !hasImageFill(n) && !(container && subtreeHasRealText(n)))
    return true;
  if (container && n.children?.length) {
    // A photo (image fill) is never an icon — flattening it to SVG embeds the
    // raster and bloats the code; let it become a background image instead.
    if (hasImageFill(n)) return false;
    // A vector mask (a country outline clipping a filled rectangle, say) has no
    // CSS equivalent: rendered layer by layer it degrades into a solid block
    // the size of the group. Flattening to one SVG is the only faithful output.
    if (hasMaskedChild(n) && !subtreeHasRealText(n)) return true;
    // Ordinary text keeps the container HTML; text bent along a path is the
    // exception — split per glyph or ringed, it only survives flattened.
    if (isSplitGlyphText(n)) return true;
    if (subtreeHasText(n)) return isTextRing(n);

    if (!subtreeHasVector(n)) return false;
    // Vectors that each live in their own frame/group are separate icons (e.g.
    // a row of social icons) — keep them split so each stays its own asset,
    // rather than merging the whole cluster into one big SVG.
    const hasNestedContainer = (n.children ?? []).some(
      (c) =>
        c.type === "FRAME" ||
        c.type === "GROUP" ||
        c.type === "INSTANCE" ||
        c.type === "COMPONENT",
    );
    if (hasNestedContainer) return false;
    return true;
  }
  return false;
}

/**
 * An image-like paint: a photo, or a video. CSS can't reproduce a Figma video
 * fill, and the plugin's PNG export of such a node yields its first frame — so
 * a video is treated exactly like a photo and lands as a still poster image.
 */
function isImagePaint(f: FigmaPaint): boolean {
  return f.visible !== false && (f.type === "IMAGE" || f.type === "VIDEO");
}

/** Does anything in this subtree paint a bitmap (photo / video fill)? */
function subtreeHasImageFill(n: FigmaNode): boolean {
  if (hasImageFill(n)) return true;
  return (n.children ?? []).some(subtreeHasImageFill);
}

function hasImageFill(n: FigmaNode): boolean {
  return (n.fills ?? []).some(isImagePaint);
}

/** True when the node's picture actually comes from a video fill (lossy: still). */
function hasVideoFill(n: FigmaNode): boolean {
  return (n.fills ?? []).some((f) => f.visible !== false && f.type === "VIDEO");
}

/** scaleMode of the first visible image/video fill (FILL / FIT / TILE / CROP). */
function imageScaleMode(n: FigmaNode): string | undefined {
  return (n.fills ?? []).find(isImagePaint)?.scaleMode;
}

// ---- Arc / donut segments ------------------------------------------------
// Figma's partial ellipse has no CSS equivalent, and exporting it as an image
// is worse than it looks: for a rotated node absoluteBoundingBox is the AABB of
// the rotated *square*, while the rendered export is bounded by the drawn arc,
// so the two never line up — stacked ring segments end up at different
// diameters. We know the geometry exactly (centre, radii, angles, rotation), so
// we draw the path ourselves and the chart lands pixel-accurate.

/**
 * Figma measures arc angles from 3 o'clock in the node's own y-down space, so
 * they already run clockwise on screen — the same direction as SVG's y-down
 * arcs — and the node's (already CSS-normalized, clockwise) rotation simply
 * adds. Verified against a stacked donut whose four cumulative sectors all
 * start at 12 o'clock and run clockwise: negating the angle instead put them
 * at 6 o'clock and reversed the slice order.
 */
function arcShapes(node: FigmaNode, w: number, h: number): SvgShape[] | null {
  const a = node.arcData;
  if (!a) return null;
  const fill = firstVisibleSolid(node.fills);
  const stroke = firstVisibleSolid(node.strokes);
  if (!fill && !stroke) return null;

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(cx, cy);
  const Ri = R * Math.max(0, Math.min(1, a.innerRadius ?? 0));
  const rot = ((node.rotation ?? 0) * Math.PI) / 180;
  const a0 = a.startingAngle + rot;
  const a1 = a.endingAngle + rot;
  const sweep = a1 - a0;
  const full = Math.abs(sweep) >= Math.PI * 2 - 0.001;

  const pt = (ang: number, rad: number) =>
    `${r(cx + rad * Math.cos(ang))} ${r(cy + rad * Math.sin(ang))}`;
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;

  let d: string;
  if (full && Ri > 0) {
    // A closed ring: two circles wound in opposite directions punch the hole
    // without relying on fill-rule (which JSX would need renamed).
    d =
      `M ${r(cx - R)} ${r(cy)} A ${r(R)} ${r(R)} 0 1 0 ${r(cx + R)} ${r(cy)} ` +
      `A ${r(R)} ${r(R)} 0 1 0 ${r(cx - R)} ${r(cy)} Z ` +
      `M ${r(cx - Ri)} ${r(cy)} A ${r(Ri)} ${r(Ri)} 0 1 1 ${r(cx + Ri)} ${r(cy)} ` +
      `A ${r(Ri)} ${r(Ri)} 0 1 1 ${r(cx - Ri)} ${r(cy)} Z`;
  } else if (full) {
    d =
      `M ${r(cx - R)} ${r(cy)} A ${r(R)} ${r(R)} 0 1 0 ${r(cx + R)} ${r(cy)} ` +
      `A ${r(R)} ${r(R)} 0 1 0 ${r(cx - R)} ${r(cy)} Z`;
  } else if (Ri > 0) {
    // Figma's cornerRadius on a ring segment rounds its two ends — that is how
    // a progress ring is drawn. Once the radius reaches half the ring's
    // thickness the ends are fully round, which is exactly a stroked centreline
    // with round caps; a filled sector would come out with blunt square ends.
    const thickness = R - Ri;
    if ((node.cornerRadius ?? 0) >= thickness / 2 - 0.5) {
      const mid = (R + Ri) / 2;
      return [
        {
          d: `M ${pt(a0, mid)} A ${r(mid)} ${r(mid)} 0 ${large} ${dir} ${pt(a1, mid)}`,
          fill: "none",
          stroke: fill ?? stroke ?? "none",
          strokeWidth: r(thickness),
          linecap: "round",
        },
      ];
    }
    d =
      `M ${pt(a0, R)} A ${r(R)} ${r(R)} 0 ${large} ${dir} ${pt(a1, R)} ` +
      `L ${pt(a1, Ri)} A ${r(Ri)} ${r(Ri)} 0 ${large} ${1 - dir} ${pt(a0, Ri)} Z`;
  } else {
    d =
      `M ${r(cx)} ${r(cy)} L ${pt(a0, R)} ` +
      `A ${r(R)} ${r(R)} 0 ${large} ${dir} ${pt(a1, R)} Z`;
  }

  const shape: SvgShape = { d, fill: fill ?? "none" };
  if (stroke) {
    shape.stroke = stroke;
    // Figma's INSIDE alignment has no SVG equivalent; a centred stroke of the
    // same weight is within half a pixel on a ring this size.
    shape.strokeWidth = r(node.strokeWeight ?? 1);
  }
  return [shape];
}

// ---- Semantic tag inference (button / h1-h6 / a) --------------------------

function directText(n: FigmaNode): boolean {
  return (n.children ?? []).some((c) => c.type === "TEXT");
}

/** A clickable button: named like one, or a small rounded filled pill of text. */
function isButtonNode(n: FigmaNode): boolean {
  if (/\b(button|btn|cta)\b/i.test(n.name)) return true;
  const container =
    n.type === "FRAME" || n.type === "INSTANCE" || n.type === "COMPONENT";
  const box = n.absoluteBoundingBox;
  const filled = firstVisibleSolid(n.fills) != null;
  const rounded = (n.cornerRadius ?? 0) >= 4;
  const small = !box || (box.height <= 72 && box.width <= 420);
  return (
    container &&
    !!n.layoutMode &&
    n.layoutMode !== "NONE" &&
    filled &&
    rounded &&
    small &&
    directText(n) &&
    !subtreeHasVectorContainer(n)
  );
}

/** Don't treat nodes that wrap nested frames as buttons. */
function subtreeHasVectorContainer(n: FigmaNode): boolean {
  return (n.children ?? []).some(
    (c) => c.type === "FRAME" || c.type === "GROUP" || c.type === "COMPONENT",
  );
}

function isLinkNode(n: FigmaNode): boolean {
  return /\b(link|ссылка)\b/i.test(n.name);
}

/** Map a container to an HTML landmark (nav/header/footer/main/section) by name. */
function landmarkTag(n: FigmaNode): IRTag | null {
  const name = n.name.toLowerCase();
  if (/\b(nav|navbar|navigation|menu|меню|навигац)\b/.test(name)) return "nav";
  if (/\b(header|topbar|top-bar|шапка|хедер)\b/.test(name)) return "header";
  if (/\b(footer|подвал|футер)\b/.test(name)) return "footer";
  if (/\b(main|основн)\b/.test(name)) return "main";
  if (/\b(section|секция|раздел)\b/.test(name)) return "section";
  return null;
}

/** Every distinct text font size in a subtree, largest first. */
function collectTextSizes(n: FigmaNode, acc: Set<number>): void {
  if (n.type === "TEXT" && n.style?.fontSize) acc.add(r(n.style.fontSize));
  for (const c of n.children ?? []) collectTextSizes(c, acc);
}

/** Map a text node to a heading level by explicit name or font size. */
function headingTag(n: FigmaNode, sizes?: number[]): IRTag | null {
  // The shared text style ("Heading/H1") is the designer's own declaration of
  // level - trust it over the layer name, which is often just the copy itself.
  const styleName = n.style?.textStyleName ?? "";
  const sm = /\bh([1-6])\b/i.exec(styleName);
  if (sm) return (`h${sm[1]}` as IRTag);
  const m = /\bh([1-6])\b/i.exec(n.name);
  if (m) return (`h${m[1]}` as IRTag);
  const named = /\b(heading|headline|title|заголовок)\b/i.test(`${n.name} ${styleName}`);
  const size = n.style?.fontSize ?? 0;
  if (named) return size >= 30 ? "h1" : "h2";
  if (size >= 36) return "h1";
  if (size >= 28) return "h2";
  if (size >= 22) return "h3";
  // Relative: the single largest text in the block is a heading even at a
  // modest size — as long as it stands clearly above the body copy around it.
  if (sizes && sizes.length >= 2 && size >= 18) {
    const max = sizes[0];
    const body = sizes[sizes.length - 1];
    if (r(size) === max && max - body >= 4) return "h2";
  }
  return null;
}

const r = (n: number) => Math.round(n);

/**
 * How the layer is composited: opacity, shadows, blur, blend mode, and its
 * place in the stack. These apply to an exported <img> exactly as they do to a
 * <div>, so they must be emitted before the asset short-circuit — a map layer
 * at 73% opacity in DIFFERENCE mode with an 18px blur otherwise lands as a
 * plain, fully opaque picture.
 */
function compositingClasses(node: FigmaNode): string[] {
  const cls: string[] = [];
  if (node.opacity != null && node.opacity < 1)
    cls.push(`opacity-[${+node.opacity.toFixed(2)}]`);

  // A background layer kept out of the flow paints behind its siblings.
  if (node.bgLayer) cls.push("-z-10");

  // All drop/inner shadows, comma-joined like CSS.
  const shadows = (node.effects ?? []).filter(
    (e) =>
      e.visible !== false &&
      (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") &&
      e.offset &&
      e.color,
  );
  if (shadows.length) {
    const parts = shadows.map((sh) => {
      const inset = sh.type === "INNER_SHADOW" ? "inset_" : "";
      return `${inset}${r(sh.offset!.x)}px_${r(sh.offset!.y)}px_${r(sh.radius ?? 0)}px_${r(sh.spread ?? 0)}px_${colorToHex(sh.color!).replace(/\s/g, "")}`;
    });
    cls.push(`shadow-[${parts.join(",")}]`);
  }

  const layerBlur = (node.effects ?? []).find(
    (e) => e.visible !== false && e.type === "LAYER_BLUR" && (e.radius ?? 0) > 0,
  );
  const bgBlur = (node.effects ?? []).find(
    (e) => e.visible !== false && e.type === "BACKGROUND_BLUR" && (e.radius ?? 0) > 0,
  );
  if (layerBlur) cls.push(`blur-[${r(layerBlur.radius ?? 0)}px]`);
  if (bgBlur) cls.push(`backdrop-blur-[${r(bgBlur.radius ?? 0)}px]`);

  const blend = blendClass(node.blendMode);
  if (blend) cls.push(blend);
  return cls;
}

/** Figma blend mode → Tailwind mix-blend utility (NORMAL / PASS_THROUGH → none). */
function blendClass(mode?: string): string | null {
  switch (mode) {
    case "MULTIPLY": return "mix-blend-multiply";
    case "SCREEN": return "mix-blend-screen";
    case "OVERLAY": return "mix-blend-overlay";
    case "DARKEN": return "mix-blend-darken";
    case "LIGHTEN": return "mix-blend-lighten";
    case "COLOR_DODGE": return "mix-blend-color-dodge";
    case "COLOR_BURN": return "mix-blend-color-burn";
    case "HARD_LIGHT": return "mix-blend-hard-light";
    case "SOFT_LIGHT": return "mix-blend-soft-light";
    case "DIFFERENCE": return "mix-blend-difference";
    case "EXCLUSION": return "mix-blend-exclusion";
    case "HUE": return "mix-blend-hue";
    case "SATURATION": return "mix-blend-saturation";
    case "COLOR": return "mix-blend-color";
    case "LUMINOSITY": return "mix-blend-luminosity";
    default: return null;
  }
}

function colorToHex(c: FigmaColor): string {
  const to = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  // No spaces inside rgba(): these values land in Tailwind arbitrary utilities
  // (text-[…] / border-[…]) where a space splits the class and drops the colour
  // (the text then falls back to black). Comma-only is valid CSS everywhere.
  if (c.a < 1) return `rgba(${r(c.r * 255)},${r(c.g * 255)},${r(c.b * 255)},${+c.a.toFixed(2)})`;
  return hex;
}

function firstVisibleSolid(paints?: FigmaPaint[]): string | null {
  return firstSolidPaint(paints)?.value ?? null;
}

/** First visible solid paint as a value + its bound variable name (if any). */
function firstSolidPaint(
  paints?: FigmaPaint[],
): { value: string; variableName?: string } | null {
  if (!paints) return null;
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === "SOLID" && p.color) {
      const a = (p.color.a ?? 1) * (p.opacity ?? 1);
      return { value: colorToHex({ ...p.color, a }), variableName: p.variableName };
    }
  }
  return null;
}

/** Colour of one gradient stop, with the paint-level opacity folded in. */
function stopColor(c: FigmaColor, paintOpacity: number): string {
  const a = (c.a ?? 1) * paintOpacity;
  return colorToHex({ ...c, a });
}

/**
 * Figma's gradient handles are normalised to the node's box (0–1 on each
 * axis), so a vector that looks like 45° in that space is *not* 45° on screen
 * unless the box is square. Converting to pixels first is what makes the
 * direction match Figma on wide/tall nodes.
 */
function handlePx(
  h: { x: number; y: number },
  w: number,
  ht: number,
): { x: number; y: number } {
  return { x: h.x * w, y: h.y * ht };
}

/**
 * A Figma linear gradient runs between two arbitrary points; CSS runs it along
 * a line through the box centre whose length is the box's projection onto that
 * angle. Same angle, different extent — so the stop offsets have to be remapped
 * onto the CSS gradient line or the colours land in the wrong place (the usual
 * "the gradient is right but shifted/stretched" complaint).
 */
function linearGradientCss(
  p: FigmaPaint,
  stops: { position: number; color: string }[],
  w: number,
  h: number,
): string {
  const hp = p.gradientHandlePositions;
  if (!hp || hp.length < 2 || !w || !h) {
    const angle = p.gradientAngle != null ? r(p.gradientAngle) : 180;
    const list = stops.map((s) => `${s.color} ${r(s.position * 100)}%`).join(", ");
    return `linear-gradient(${angle}deg, ${list})`;
  }
  const p0 = handlePx(hp[0], w, h);
  const p1 = handlePx(hp[1], w, h);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  // CSS 0deg points up and grows clockwise; Figma's y axis grows downward.
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  const rad = (deg * Math.PI) / 180;
  // Unit vector of the CSS gradient line and its length for this box.
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const len = Math.abs(w * ux) + Math.abs(h * uy);
  if (!len) return `linear-gradient(${r(deg)}deg, ${stops.map((s) => s.color).join(", ")})`;
  const cx = w / 2;
  const cy = h / 2;
  const proj = (q: { x: number; y: number }) =>
    ((q.x - cx) * ux + (q.y - cy) * uy + len / 2) / len;
  const a = proj(p0);
  const b = proj(p1);
  const list = stops
    .map((s) => `${s.color} ${r((a + s.position * (b - a)) * 100)}%`)
    .join(", ");
  return `linear-gradient(${r(deg)}deg, ${list})`;
}

function gradientCss(p: FigmaPaint, w = 0, h = 0): string | null {
  if (!p.gradientStops?.length) return null;
  const paintOpacity = p.opacity ?? 1;
  const stops = p.gradientStops.map((s) => ({
    position: s.position,
    color: stopColor(s.color, paintOpacity),
  }));
  const list = stops.map((s) => `${s.color} ${r(s.position * 100)}%`).join(", ");
  const hp = p.gradientHandlePositions;

  if (p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_DIAMOND") {
    // Handles: [0] centre, [1] end of the horizontal radius, [2] end of the
    // vertical radius — all normalised to the box, so each radius has to be
    // measured in pixels and then expressed against its own axis.
    if (hp && hp.length >= 3 && w && h) {
      const c = handlePx(hp[0], w, h);
      const e1 = handlePx(hp[1], w, h);
      const e2 = handlePx(hp[2], w, h);
      const rx = Math.hypot(e1.x - c.x, e1.y - c.y);
      const ry = Math.hypot(e2.x - c.x, e2.y - c.y);
      const cxp = r((c.x / w) * 100);
      const cyp = r((c.y / h) * 100);
      return `radial-gradient(ellipse ${r((rx / w) * 100)}% ${r((ry / h) * 100)}% at ${cxp}% ${cyp}%, ${list})`;
    }
    return `radial-gradient(circle, ${list})`;
  }

  if (p.type === "GRADIENT_ANGULAR") {
    // An angular sweep *is* a conic gradient — no approximation needed.
    let from = 0;
    let cxp = 50;
    let cyp = 50;
    if (hp && hp.length >= 2 && w && h) {
      const c = handlePx(hp[0], w, h);
      const e = handlePx(hp[1], w, h);
      const deg = (Math.atan2(e.x - c.x, -(e.y - c.y)) * 180) / Math.PI;
      from = r(((deg % 360) + 360) % 360);
      cxp = r((c.x / w) * 100);
      cyp = r((c.y / h) * 100);
    }
    const conic = stops
      .map((s) => `${s.color} ${r(s.position * 360)}deg`)
      .join(", ");
    return `conic-gradient(from ${from}deg at ${cxp}% ${cyp}%, ${conic})`;
  }

  return linearGradientCss(p, stops, w, h);
}

function bbox(n: FigmaNode): FigmaRect | undefined {
  return n.absoluteBoundingBox;
}

/**
 * Figma's absoluteBoundingBox for a rotated node is its axis-aligned bounding
 * box, not the un-rotated rectangle. Emitting that box + `rotate()` double-
 * counts the rotation (the element renders too big and offset). This recovers
 * the un-rotated width/height/left-top so that `rotate()` around the centre
 * reproduces the original AABB. Ported from FigmaToCode's
 * calculateRectangleFromBoundingBox. `cssRotationDeg` is already clockwise
 * (the plugin negates Figma's counter-clockwise value).
 */
function unrotatedRect(
  box: FigmaRect,
  cssRotationDeg: number,
  size?: { x: number; y: number },
): FigmaRect {
  const theta = (cssRotationDeg * Math.PI) / 180;
  const ac = Math.abs(Math.cos(theta));
  const as = Math.abs(Math.sin(theta));
  // The AABB (Wb,Hb) of a w×h rectangle rotated by θ satisfies:
  //   Wb = w·|cos| + h·|sin|,  Hb = w·|sin| + h·|cos|.
  // Solve for w,h. denom = |cos|²−|sin|² vanishes only near 45° (singular).
  const denom = ac * ac - as * as;
  let w: number;
  let h: number;
  if (size && size.x > 0 && size.y > 0) {
    // Exact size straight off the node — no inversion needed.
    w = size.x;
    h = size.y;
  } else if (Math.abs(denom) < 1e-4) {
    // Singular at ~45°, except for a square: there w = h, so the AABB gives
    // Wb = w·(|cos|+|sin|) — one equation, one unknown. A donut ring turned 45°
    // is exactly this case, and without it the circle inflates by √2.
    if (Math.abs(box.width - box.height) > 1) return box;
    const side = box.width / (ac + as);
    if (!(side > 0)) return box;
    w = side;
    h = side;
  } else {
    w = (box.width * ac - box.height * as) / denom;
    h = (box.height * ac - box.width * as) / denom;
  }
  if (!(w > 0) || !(h > 0)) return box;
  // The un-rotated rectangle shares the AABB's centre (CSS rotate() spins around
  // the centre), so recover the top-left from the size difference.
  return {
    x: box.x + (box.width - w) / 2,
    y: box.y + (box.height - h) / 2,
    width: r(w),
    height: r(h),
  };
}

// ---- Geometric flow detection (free-form frame → flex row/column/grid) -----
// Figma's own inferredAutoLayout only recognises a single clean row or column,
// so a repeated grid of cards (2×3, 3×4, …) always falls through to absolute
// left/top soup. This recovers the common cases — a uniform row, column, or
// grid — from the children's geometry so we can emit flex / flex-wrap instead.

interface InferredFlow {
  layoutMode: "HORIZONTAL" | "VERTICAL";
  /** primary-axis gap (between columns in a grid/row) */
  itemSpacing: number;
  /** true for a grid: wrap the row so it breaks into multiple lines */
  wrap?: boolean;
  /** cross-axis gap between grid rows */
  counterSpacing?: number;
  /** inset of the flow content from the frame edges (from the child geometry) */
  paddingLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  /** full child render order: absolute background layers first, then the flow */
  children: FigmaNode[];
  /** a full-bleed background leaf whose fill/radius/stroke/shadow should be
   *  folded into the container itself (the idiomatic form) instead of kept as a
   *  separate absolute layer. */
  mergeBackground?: FigmaNode;
}

/** Any visible paint (solid / gradient / image) that fills the node's box. */
function hasVisibleFill(n: FigmaNode): boolean {
  return (n.fills ?? []).some(
    (f) =>
      f.visible !== false &&
      (f.type === "SOLID" || f.type.startsWith("GRADIENT") || isImagePaint(f)),
  );
}

/** Fraction of the smaller box's area covered by the intersection (0–1). */
function areaOverlap(a: FigmaRect, b: FigmaRect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const min = Math.min(a.width * a.height, b.width * b.height);
  return min > 0 ? (w * h) / min : 0;
}

/** Vertical overlap (px) of two boxes — the test for "same row". */
function vOverlap(a: FigmaRect, b: FigmaRect): number {
  return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

/** Average of `gaps` when they're all within tolerance and none is a real
 *  overlap (< -2px); otherwise null (the spacing isn't a clean, uniform flow). */
function uniformGap(gaps: number[]): number | null {
  if (!gaps.length) return null;
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  if (min < -2) return null;
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const tol = Math.max(4, Math.abs(avg) * 0.15);
  if (max - min > tol) return null;
  return Math.max(0, avg);
}

/** True when every value is within `tol` of the first (columns/widths align). */
function allClose(values: number[], tol = 3): boolean {
  return values.every((v) => Math.abs(v - values[0]) <= tol);
}

/**
 * Detect a uniform row / column / grid among a free-form frame's children from
 * their bounding boxes. Returns a synthetic auto-layout description the existing
 * flex path can consume, or null when the children don't cleanly flow (they
 * overlap, or the spacing is irregular) — in which case absolute wins.
 */
function inferFlowLayout(node: FigmaNode): InferredFlow | null {
  const pbox = node.absoluteBoundingBox;
  const box = (c: FigmaNode) => c.absoluteBoundingBox!;
  const visible = (node.children ?? []).filter(
    (c) =>
      c.visible !== false &&
      c.absoluteBoundingBox &&
      c.layoutPositioning !== "ABSOLUTE",
  );

  // A full-bleed background layer (a rectangle covering ~all of the frame) is a
  // decorative sibling, not part of the flow — set it aside as an absolute layer
  // so header/grid siblings can still be detected as a clean row/column/grid.
  const parentArea = pbox ? pbox.width * pbox.height : 0;
  const backgrounds = visible.filter(
    (c) => parentArea > 0 && box(c).width * box(c).height >= parentArea * 0.9,
  );
  const kids = visible.filter((c) => !backgrounds.includes(c));
  // Attempt only when there were extra siblings to justify the guess.
  if (kids.length < 2) return null;
  if (backgrounds.length === 0 && kids.length < 3) return null;

  // Overlapping children are free-form art / stacked layers, not a flow.
  for (let i = 0; i < kids.length; i++)
    for (let j = i + 1; j < kids.length; j++)
      if (areaOverlap(box(kids[i]), box(kids[j])) > 0.25) return null;

  // Content inset from the frame edges → the container's padding.
  const minX = Math.min(...kids.map((c) => box(c).x));
  const minY = Math.min(...kids.map((c) => box(c).y));
  const maxX = Math.max(...kids.map((c) => box(c).x + box(c).width));
  const maxY = Math.max(...kids.map((c) => box(c).y + box(c).height));
  const pad = pbox
    ? {
        paddingLeft: Math.max(0, minX - pbox.x),
        paddingTop: Math.max(0, minY - pbox.y),
        paddingRight: Math.max(0, pbox.x + pbox.width - maxX),
        paddingBottom: Math.max(0, pbox.y + pbox.height - maxY),
      }
    : { paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0 };
  // The idiomatic form: a single full-bleed background rectangle IS the
  // container's background — fold its fill/radius/stroke/shadow into the parent
  // and drop the element, but only when the parent has no fill of its own and
  // the layer is a plain, opaque, unrotated leaf (a genuine backdrop).
  let mergeBackground: FigmaNode | undefined;
  let overlays = backgrounds;
  if (
    backgrounds.length === 1 &&
    !hasVisibleFill(node) &&
    !(backgrounds[0].children?.length) &&
    (backgrounds[0].opacity ?? 1) >= 1 &&
    !(backgrounds[0].rotation && Math.abs(backgrounds[0].rotation) > 0.5) &&
    pbox &&
    box(backgrounds[0]).width * box(backgrounds[0]).height >= parentArea * 0.98
  ) {
    mergeBackground = backgrounds[0];
    overlays = [];
  }
  // Any remaining background layers stay as absolute overlays, pushed behind the
  // now-in-flow siblings (bgLayer → -z-10 on the container's isolated context).
  const bg = overlays.map(
    (c) => ({ ...c, layoutPositioning: "ABSOLUTE", bgLayer: true }) as FigmaNode,
  );
  // Fields shared by every successful return: padding + the merge candidate.
  const extra = { ...pad, mergeBackground };
  const flow = (order: FigmaNode[]): InferredFlow["children"] => [...bg, ...order];

  // Cluster into rows: a child joins a row when it overlaps it vertically.
  const byTop = [...kids].sort((a, b) => box(a).y - box(b).y);
  const rows: FigmaNode[][] = [];
  for (const k of byTop) {
    const kb = box(k);
    const row = rows.find((rr) => {
      const rb = box(rr[0]);
      return vOverlap(kb, rb) > 0.5 * Math.min(kb.height, rb.height);
    });
    if (row) row.push(k);
    else rows.push([k]);
  }
  for (const rr of rows) rr.sort((a, b) => box(a).x - box(b).x);

  const horizGaps = (row: FigmaNode[]): number | null => {
    const g: number[] = [];
    for (let i = 1; i < row.length; i++)
      g.push(box(row[i]).x - (box(row[i - 1]).x + box(row[i - 1]).width));
    return uniformGap(g);
  };

  const cols = rows[0].length;

  // ---- Grid: >1 row, every row the same width, columns & widths aligned ----
  if (rows.length > 1 && cols > 1 && rows.every((rr) => rr.length === cols)) {
    const colGaps = rows.map(horizGaps);
    const colStarts = rows.map((rr) => rr.map((c) => box(c).x));
    const widths = kids.map((c) => box(c).width);
    const columnsAligned = Array.from({ length: cols }).every((_, j) =>
      allClose(colStarts.map((s) => s[j])),
    );
    const rowTops = rows.map((rr) => Math.min(...rr.map((c) => box(c).y)));
    const rowBots = rows.map((rr) => Math.max(...rr.map((c) => box(c).y + box(c).height)));
    const rowGaps: number[] = [];
    for (let i = 1; i < rows.length; i++) rowGaps.push(rowTops[i] - rowBots[i - 1]);
    const colGap = uniformGap(colGaps.filter((g): g is number => g != null));
    const rowGap = uniformGap(rowGaps);
    if (
      colGap != null &&
      rowGap != null &&
      columnsAligned &&
      allClose(widths, Math.max(4, widths[0] * 0.1)) &&
      colGaps.every((g) => g != null)
    ) {
      return {
        layoutMode: "HORIZONTAL",
        itemSpacing: colGap,
        wrap: true,
        counterSpacing: rowGap,
        ...extra,
        children: flow(rows.flat()),
      };
    }
    return null;
  }

  // ---- Single row ----
  if (rows.length === 1) {
    const g = horizGaps(rows[0]);
    if (g != null)
      return { layoutMode: "HORIZONTAL", itemSpacing: g, ...extra, children: flow(rows[0]) };
    return null;
  }

  // ---- Single column (every row holds exactly one item) ----
  if (rows.every((rr) => rr.length === 1)) {
    const tops = rows.map((rr) => box(rr[0]).y);
    const bots = rows.map((rr) => box(rr[0]).y + box(rr[0]).height);
    const g: number[] = [];
    for (let i = 1; i < rows.length; i++) g.push(tops[i] - bots[i - 1]);
    const gap = uniformGap(g);
    if (gap != null)
      return { layoutMode: "VERTICAL", itemSpacing: gap, ...extra, children: flow(rows.flat()) };
  }
  return null;
}

/**
 * A rotated container whose rotation must not be re-applied in CSS.
 *
 * Figma stores a node's rotation relative to its parent but its bounding box in
 * absolute (already rotated) coordinates. Wherever we pin children by those
 * boxes, the parent's turn is baked into the numbers, so wrapping them in a
 * `rotate()` turns everything twice. That covers two shapes of layer:
 *
 *  - a free-form rotated group: its children get absolute left/top;
 *  - a frame whose rotation every child undoes (net zero on screen): Figma lays
 *    it out in its own turned space, which CSS cannot do because `rotate()`
 *    does not affect layout — flex would size the children along the wrong axis
 *    and scatter them outside the frame.
 *
 * An ordinary rotated auto-layout frame is *not* included: its children flow in
 * the frame's local space, which `rotate()` reproduces correctly.
 */
function flattensRotation(node: FigmaNode, opts: ConvertOptions): boolean {
  const rot = node.rotation ?? 0;
  if (Math.abs(rot) < 0.5) return false;
  const kids = node.children ?? [];
  if (!kids.length) return false;
  // Every child undoes the rotation → the frame only looks turned in Figma.
  if (kids.every((c) => Math.abs((c.rotation ?? 0) + rot) < 1)) return true;
  // Otherwise only when the children are about to be pinned by their boxes.
  return !!opts.absolutePositioning && (!node.layoutMode || node.layoutMode === "NONE");
}

/** Record a non-fatal conversion note (deduped later). */
function warn(opts: ConvertOptions, node: FigmaNode, msg: string): void {
  opts.warnings?.push(`${node.name || node.type}: ${msg}`);
}

/** Convert one Figma node (and its subtree) into an IR element. */
function nodeToIR(
  node: FigmaNode,
  parent: FigmaNode | null,
  opts: ConvertOptions,
  assets: AssetRef[],
): IRElement | null {
  if (node.visible === false) return null;

  const el: IRElement = {
    tag: "div",
    classes: [],
    style: {},
    children: [],
    // A component instance's name (e.g. "Button") makes for far better class /
    // component identifiers than an anonymous "Frame 12".
    name: node.componentName || node.name,
  };
  // A rotated container whose children are placed by their absolute boxes: the
  // turn is already baked into those coordinates, so we drop it here and fold
  // it into the children (Figma stores their rotation relative to the parent).
  // See flattensRotation.
  if (flattensRotation(node, opts)) {
    node = {
      ...node,
      rotation: 0,
      layoutMode: "NONE",
      inferredLayout: undefined,
      // Its children are about to be pinned absolutely, so there is no longer
      // any flow content to hug — a hug-sized frame would collapse to nothing
      // and its text would spill out. Pin it to the size it actually occupies.
      layoutSizingHorizontal:
        node.layoutSizingHorizontal === "HUG" ? "FIXED" : node.layoutSizingHorizontal,
      layoutSizingVertical:
        node.layoutSizingVertical === "HUG" ? "FIXED" : node.layoutSizingVertical,
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      children: node.children!.map((c) => ({
        ...c,
        rotation: (c.rotation ?? 0) + (node.rotation ?? 0),
      })),
    };
  }

  // A rotated child breaks every flow inference: Figma reads its rotated
  // bounding box (a chart's y-axis caption is tall and narrow, sitting to the
  // left of everything), but in CSS `rotate()` does not affect layout, so the
  // element still takes up its wide, short unrotated box and lands somewhere
  // else entirely — the two axis captions swap places. Pin such a frame's
  // children by their real boxes instead.
  const flowable = !(node.children ?? []).some((c) => Math.abs(c.rotation ?? 0) >= 0.5);

  // Opt-in: adopt Figma's inferred auto-layout for a free-form frame so the
  // existing auto-layout→flex path fires (children flow instead of being pinned
  // with absolute left/top). Children are sorted along the primary axis because
  // Figma's children array is in z-order, not visual order.
  if (
    opts.inferLayout &&
    flowable &&
    node.inferredLayout &&
    (!node.layoutMode || node.layoutMode === "NONE") &&
    node.children &&
    node.children.length > 1
  ) {
    const il = node.inferredLayout;
    const horiz = il.layoutMode === "HORIZONTAL";
    const sorted = [...node.children].sort((a, b) => {
      const ba = a.absoluteBoundingBox;
      const bb = b.absoluteBoundingBox;
      if (!ba || !bb) return 0;
      return horiz ? ba.x - bb.x : ba.y - bb.y;
    });
    node = {
      ...node,
      layoutMode: il.layoutMode,
      itemSpacing: il.itemSpacing,
      paddingLeft: il.paddingLeft,
      paddingRight: il.paddingRight,
      paddingTop: il.paddingTop,
      paddingBottom: il.paddingBottom,
      primaryAxisAlignItems: il.primaryAxisAlignItems,
      counterAxisAlignItems: il.counterAxisAlignItems,
      children: sorted,
    };
  } else if (
    // No inferred layout from Figma (it only spots single-axis flows) — recover
    // a uniform row / column / grid from the children's geometry ourselves.
    opts.inferLayout &&
    flowable &&
    (!node.layoutMode || node.layoutMode === "NONE") &&
    node.children &&
    node.children.length > 2
  ) {
    const flow = inferFlowLayout(node);
    if (flow) {
      node = {
        ...node,
        layoutMode: flow.layoutMode,
        itemSpacing: flow.itemSpacing,
        layoutWrap: flow.wrap ? "WRAP" : node.layoutWrap,
        counterAxisSpacing: flow.counterSpacing,
        paddingLeft: flow.paddingLeft,
        paddingRight: flow.paddingRight,
        paddingTop: flow.paddingTop,
        paddingBottom: flow.paddingBottom,
        children: flow.children,
      };
      // Fold a full-bleed background leaf into the container itself (fill /
      // radius / stroke / shadow) — the way a developer would write it, instead
      // of leaving a separate absolute layer behind everything.
      const b = flow.mergeBackground;
      if (b) {
        node = {
          ...node,
          fills: b.fills,
          cornerRadius: b.cornerRadius,
          cornerRadiusVar: b.cornerRadiusVar,
          rectangleCornerRadii: b.rectangleCornerRadii,
          strokes: b.strokes,
          strokeWeight: b.strokeWeight,
          strokeAlign: b.strokeAlign,
          strokeDashes: b.strokeDashes,
          individualStrokeWeights: b.individualStrokeWeights,
          effects: node.effects ?? b.effects,
        };
      }
    }
  }

  const cls = el.classes;
  const box = bbox(node);
  const rotDeg = node.rotation && Math.abs(node.rotation) > 0.5 ? node.rotation : 0;

  // An exported node (icon / photo) is rendered by Figma *as it appears*, so the
  // picture already carries the rotation and its frame is the rotated bounding
  // box. Sizing such an <img> by the un-rotated rectangle turns a vertical grid
  // line — a horizontal LINE turned 90° — back into a horizontal one 369px
  // wide, which then blows the column it sits in wide open.
  const isTextNode = node.type === "TEXT";
  // A partial ellipse is the exception: we draw it ourselves (see arcShapes)
  // from the un-rotated circle, folding the rotation into the path's angles.
  const exported =
    !isArcEllipse(node) &&
    ((isTextNode ? isCurvedTextNode(node) : isIconNode(node)) ||
      (!isTextNode && hasImageFill(node) && !node.children?.length));

  // Everything else keeps its un-rotated rectangle and gets a `rotate()` below.
  const geo = box && rotDeg && !exported ? unrotatedRect(box, rotDeg, node.size) : box;
  // unrotatedRect returns the AABB unchanged when it can't invert the rotation
  // (a non-square node at ~45°, with no exact size from the plugin) — position
  // and size may be off there; note it rather than fail silently.
  if (!exported && geo && box && rotDeg && geo.width === box.width && geo.height === box.height)
    warn(opts, node, `rotation near 45° — position approximated`);

  // Component boolean / instance-swap properties (JSX only) — set early so they
  // survive the asset-export short-circuit below (a swapped icon returns early).
  // BOOLEAN → `{show && (...)}`, INSTANCE_SWAP → a `{icon}` ReactNode slot.
  if (node.visibleProp) {
    const pn = propIdent(node.visibleProp);
    if (opts.propNames?.has(pn)) el.condProp = pn;
  }
  if (node.swapProp) {
    const pn = propIdent(node.swapProp);
    if (opts.propNames?.has(pn)) el.slotProp = pn;
  }

  const isText = node.type === "TEXT";
  // Curved (path) text skips the text pipeline entirely: it becomes an <img>
  // like an icon, and — unlike straight text — needs its w/h emitted.
  const curvedText = isText && isCurvedTextNode(node);
  const isAutoLayout = node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
  const parentAuto = parent?.layoutMode === "HORIZONTAL" || parent?.layoutMode === "VERTICAL";

  // ---- Positioning ----
  // Figma allows absolutely-positioned children inside auto-layout frames
  // (layoutPositioning: "ABSOLUTE") — treat them like free-form children.
  const absInAuto = parentAuto && node.layoutPositioning === "ABSOLUTE";
  // Constraints turn a fixed-position child into a responsive one: pinned to
  // the right/bottom, stretched between both edges, or centered.
  let constraintNoW = false;
  let constraintNoH = false;
  if (
    opts.absolutePositioning &&
    parent &&
    (!parentAuto || absInAuto) &&
    box &&
    bbox(parent)
  ) {
    const pb = bbox(parent)!;
    const g = geo!;
    cls.push("absolute");
    const leftPx = r(g.x - pb.x);
    const topPx = r(g.y - pb.y);
    const rightPx = r(pb.x + pb.width - (g.x + g.width));
    const bottomPx = r(pb.y + pb.height - (g.y + g.height));
    const ch = node.constraints?.horizontal;
    const cv = node.constraints?.vertical;

    // Horizontal
    if (ch === "MAX") cls.push(`right-[${rightPx}px]`);
    else if (ch === "STRETCH") {
      cls.push(`left-[${leftPx}px]`, `right-[${rightPx}px]`);
      constraintNoW = true;
    } else if (ch === "CENTER") {
      // Figma CENTER keeps a fixed offset from the parent's centre, not exact
      // centering — preserve that offset so off-centre elements don't collapse
      // onto the middle (and overlap their neighbours).
      const off = r(g.x + g.width / 2 - (pb.x + pb.width / 2));
      if (off === 0) cls.push("left-1/2");
      else cls.push(`left-[calc(50%_${off < 0 ? "-" : "+"}_${Math.abs(off)}px)]`);
      cls.push("-translate-x-1/2");
    } else if (ch === "SCALE" && pb.width) {
      cls.push(`left-[${((g.x - pb.x) / pb.width * 100).toFixed(1)}%]`);
      el.style["width"] = `${(g.width / pb.width * 100).toFixed(1)}%`;
      constraintNoW = true;
    } else cls.push(`left-[${leftPx}px]`);

    // Vertical
    if (cv === "MAX") cls.push(`bottom-[${bottomPx}px]`);
    else if (cv === "STRETCH") {
      cls.push(`top-[${topPx}px]`, `bottom-[${bottomPx}px]`);
      constraintNoH = true;
    } else if (cv === "CENTER") {
      const off = r(g.y + g.height / 2 - (pb.y + pb.height / 2));
      if (off === 0) cls.push("top-1/2");
      else cls.push(`top-[calc(50%_${off < 0 ? "-" : "+"}_${Math.abs(off)}px)]`);
      cls.push("-translate-y-1/2");
    } else if (cv === "SCALE" && pb.height) {
      cls.push(`top-[${((g.y - pb.y) / pb.height * 100).toFixed(1)}%]`);
      el.style["height"] = `${(g.height / pb.height * 100).toFixed(1)}%`;
      constraintNoH = true;
    } else cls.push(`top-[${topPx}px]`);
  }

  // ---- Auto-layout → flex ----
  if (isAutoLayout) {
    cls.push("flex");
    if (node.layoutMode === "VERTICAL") cls.push("flex-col");
    if (node.layoutWrap === "WRAP") cls.push("flex-wrap");
    // A wrapped grid can have different column vs row gaps → gap-x / gap-y;
    // otherwise the single `gap` shorthand (or its variable token).
    const cross = node.counterAxisSpacing;
    if (
      node.layoutWrap === "WRAP" &&
      cross != null &&
      r(cross) !== r(node.itemSpacing ?? 0)
    ) {
      if (node.itemSpacing) cls.push(`gap-x-[${r(node.itemSpacing)}px]`);
      if (cross) cls.push(`gap-y-[${r(cross)}px]`);
    } else if (node.itemSpacing)
      cls.push(node.itemSpacingVar ? `gap-${node.itemSpacingVar}` : `gap-[${r(node.itemSpacing)}px]`);

    const pl = r(node.paddingLeft ?? 0);
    const pr = r(node.paddingRight ?? 0);
    const pt = r(node.paddingTop ?? 0);
    const pb = r(node.paddingBottom ?? 0);
    const padVars =
      node.paddingLeftVar || node.paddingRightVar || node.paddingTopVar || node.paddingBottomVar;
    // Per-side token classes (pl-md) when any side is variable-bound; otherwise
    // the compact px form (p-4 / px-6 / pt-2) as before.
    const side = (v: number, name: string | undefined, prefix: string) => {
      if (name) cls.push(`${prefix}-${name}`);
      else if (v) cls.push(`${prefix}-[${v}px]`);
    };
    if (padVars) {
      side(pl, node.paddingLeftVar, "pl");
      side(pr, node.paddingRightVar, "pr");
      side(pt, node.paddingTopVar, "pt");
      side(pb, node.paddingBottomVar, "pb");
    } else if (pl || pr || pt || pb) {
      if (pl === pr && pt === pb && pl === pt) cls.push(`p-[${pl}px]`);
      else {
        if (pl === pr) cls.push(`px-[${pl}px]`);
        else {
          if (pl) cls.push(`pl-[${pl}px]`);
          if (pr) cls.push(`pr-[${pr}px]`);
        }
        if (pt === pb) cls.push(`py-[${pt}px]`);
        else {
          if (pt) cls.push(`pt-[${pt}px]`);
          if (pb) cls.push(`pb-[${pb}px]`);
        }
      }
    }

    // Figma clips an overflowing auto-layout frame at its far edge whatever the
    // alignment says; CSS instead pushes the excess out of the *near* edge,
    // where `overflow: hidden` makes it unreachable — the first column of a
    // too-wide table disappears off the left. Fall back to start alignment,
    // which is what the frame actually looks like.
    const justify = overflowsPrimaryAxis(node)
      ? null
      : axisToJustify(node.primaryAxisAlignItems);
    if (justify) cls.push(justify);
    const align = axisToAlign(node.counterAxisAlignItems);
    if (align) cls.push(align);

    // Containing block for layoutPositioning:"ABSOLUTE" children.
    if ((node.children ?? []).some((c) => c.layoutPositioning === "ABSOLUTE"))
      cls.push("relative");
    // A background layer sits at -z-10; isolate keeps that stacking local so it
    // paints behind the in-flow siblings without slipping under outer content.
    if ((node.children ?? []).some((c) => c.bgLayer)) cls.push("isolate");
  }

  // ---- Size ----
  // FILL children stretch/grow with the parent instead of a fixed px size —
  // hard-coding their canvas width is what makes forms/buttons drift.
  const rowParent = parent?.layoutMode === "HORIZONTAL";
  const fillW =
    !absInAuto &&
    (node.layoutSizingHorizontal === "FILL" ||
      (parentAuto &&
        (rowParent
          ? (node.layoutGrow ?? 0) > 0
          : node.layoutAlign === "STRETCH")));
  const fillH =
    !absInAuto &&
    (node.layoutSizingVertical === "FILL" ||
      (parentAuto &&
        (rowParent
          ? node.layoutAlign === "STRETCH"
          : (node.layoutGrow ?? 0) > 0)));
  // Figma's FILL splits the main axis evenly, so the CSS needs a zero basis:
  // plain `grow` distributes only the *leftover* space around each item's
  // content, which makes text-heavy cards wider than their siblings — and under
  // flex-wrap it sizes them by max-content and wraps instead of sharing.
  if (fillW) cls.push(...(rowParent ? ["grow", "basis-0"] : ["w-full"]));
  if (fillH) cls.push(...(rowParent ? ["self-stretch"] : ["grow", "basis-0"]));

  // Figma never shrinks an item below its size unless it's set to "Fill" along
  // the layout axis; CSS flex items shrink by default (flex-shrink: 1). Without
  // shrink-0 the siblings squish unevenly as the container narrows and the
  // whole row/column drifts out of place — pin every non-Fill child.
  if (parentAuto && !absInAuto) {
    const mainAxisFill = rowParent ? fillW : fillH;
    if (!mainAxisFill) cls.push("shrink-0");
  }

  if (geo && (!isText || curvedText)) {
    // A LINE (or a stroke-only divider) has a zero-height/width box; fall back
    // to the stroke weight so it doesn't collapse to h-[0px]. The test has to
    // be sub-pixel, not "=== 0": rotating a line leaves floating-point dust
    // (1e-13) in the bounding box, which is truthy and then rounds to nothing —
    // a vertical grid line silently disappears.
    const hairline = (v: number) => v < 0.5;
    const w = hairline(geo.width) ? node.strokeWeight || 1 : geo.width;
    const h = hairline(geo.height) ? node.strokeWeight || 1 : geo.height;
    const hugW =
      node.layoutSizingHorizontal === "HUG" ||
      (isAutoLayout &&
        (node.layoutMode === "HORIZONTAL"
          ? node.primaryAxisSizingMode === "AUTO"
          : node.counterAxisSizingMode === "AUTO"));
    const hugH =
      node.layoutSizingVertical === "HUG" ||
      (isAutoLayout &&
        (node.layoutMode === "VERTICAL"
          ? node.primaryAxisSizingMode === "AUTO"
          : node.counterAxisSizingMode === "AUTO"));
    if (!fillW && !hugW && !constraintNoW) cls.push(`w-[${r(w)}px]`);
    if (!fillH && !hugH && !constraintNoH) cls.push(`h-[${r(h)}px]`);
  }

  // Auto-layout min/max constraints — the key to responsive blocks that grow
  // but cap their width (max-w) instead of hard-locking a single px size.
  if (node.minWidth != null) cls.push(`min-w-[${r(node.minWidth)}px]`);
  if (node.maxWidth != null) cls.push(`max-w-[${r(node.maxWidth)}px]`);
  if (node.minHeight != null) cls.push(`min-h-[${r(node.minHeight)}px]`);
  if (node.maxHeight != null) cls.push(`max-h-[${r(node.maxHeight)}px]`);

  // ---- Corner rounding ----
  // Must precede the asset export below: an exported <img> (photo / video /
  // icon) returns early, so a radius emitted after it would be dropped and the
  // picture would render with square corners. Rounding is a pure CSS clip, so
  // it stays correct even when the exported asset already has the corners cut.
  // On a partial ellipse cornerRadius rounds the arc's ends (handled by
  // arcShapes), not the element's box — emitting it as border-radius would clip
  // the drawing instead.
  if (isArcEllipse(node)) {
    /* nothing: see arcShapes */
  } else if (node.type === "ELLIPSE") cls.push("rounded-full");
  else if (node.cornerRadius)
    cls.push(node.cornerRadiusVar ? `rounded-${node.cornerRadiusVar}` : `rounded-[${r(node.cornerRadius)}px]`);
  else if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    if (tl === tr && tr === br && br === bl) {
      if (tl) cls.push(`rounded-[${r(tl)}px]`);
    } else {
      if (tl) cls.push(`rounded-tl-[${r(tl)}px]`);
      if (tr) cls.push(`rounded-tr-[${r(tr)}px]`);
      if (br) cls.push(`rounded-br-[${r(br)}px]`);
      if (bl) cls.push(`rounded-bl-[${r(bl)}px]`);
    }
  }

  // Compositing (opacity / shadow / blur / blend / stacking) must also precede
  // the export short-circuit — an <img> is composited like any other element.
  cls.push(...compositingClasses(node));

  // ---- Asset export (icons → SVG, image/video fills → PNG) ----
  // Detect before background/children so icons don't become empty boxes.
  // Curved text is an "icon" too: only an SVG can bend the glyphs.
  // A partial ellipse is drawn, not exported — see arcShapes.
  if (isArcEllipse(node) && geo) {
    const shapes = arcShapes(node, geo.width, geo.height);
    if (shapes) {
      el.svg = { viewBox: `0 0 ${r(geo.width)} ${r(geo.height)}`, shapes };
      return el;
    }
  }

  const icon = isText ? curvedText : isIconNode(node);
  const imageLeaf = !isText && !icon && hasImageFill(node) && !node.children?.length;
  // `exported` (computed with the geometry above) must agree, or the <img> gets
  // sized for the wrong rectangle.
  if ((icon || imageLeaf) !== exported && !isArcEllipse(node))
    warn(opts, node, "внутреннее несоответствие: экспорт и геометрия разошлись");
  // A video fill can't survive as a video — it lands as its first frame.
  if (!isText && hasVideoFill(node))
    warn(opts, node, "видео экспортировано первым кадром (статичная картинка)");
  if (icon || imageLeaf) {
    el.tag = "img";
    // An "icon" built on a raster — a photo clipped by a vector mask, say —
    // has no vectors to preserve: an SVG export would just wrap the bitmap in
    // base64 and bloat the output, so render it straight to PNG.
    const kind: "svg" | "png" = icon && !subtreeHasImageFill(node) ? "svg" : "png";
    el.asset = { id: node.id, kind };
    if (kind === "svg") cls.push("object-contain");
    // Respect the fill's scaleMode: FIT keeps the whole image (contain),
    // FILL/CROP fill the box (cover). Default to cover when unknown.
    else cls.push(imageScaleMode(node) === "FIT" ? "object-contain" : "object-cover");
    assets.push({ id: node.id, kind, className: cls.join(" "), name: node.name });
    return el;
  }

  // ---- Free-form container becomes a positioning context ----
  // An absolutely-positioned element is already a containing block for its
  // children; adding `relative` on top would override `absolute` (it comes
  // later in Tailwind's CSS) and knock the node back into normal flow.
  if (
    opts.absolutePositioning &&
    !isAutoLayout &&
    node.children?.length &&
    !isText &&
    !cls.includes("absolute")
  ) {
    cls.push("relative");
  }

  // ---- Fills / background ----
  if (!isText) {
    const fills = node.fills ?? [];
    const grads = fills.filter(
      (f) => f.visible !== false && f.type.startsWith("GRADIENT"),
    );
    const img = fills.find(isImagePaint);
    const solidPaint = firstSolidPaint(fills);
    if (grads.length) {
      // A diamond gradient has no CSS equivalent — the closest match is a
      // radial one, so flag it as lossy. (Angular maps exactly to conic.)
      for (const grad of grads)
        if (grad.type === "GRADIENT_DIAMOND")
          warn(opts, node, "GRADIENT_DIAMOND приближён радиальным градиентом");
      // Stack every gradient into one `background`. CSS paints the first layer
      // on top; Figma's fills[0] is the bottom layer — so reverse. A solid fill
      // beneath the gradients becomes the last (bottom) layer, expressed as a
      // flat gradient so it can share the shorthand.
      const gw = geo?.width ?? 0;
      const gh = geo?.height ?? 0;
      const layers = [...grads]
        .reverse()
        .map((g) => gradientCss(g, gw, gh))
        .filter(Boolean) as string[];
      if (solidPaint)
        layers.push(`linear-gradient(${solidPaint.value},${solidPaint.value})`);
      if (layers.length) el.style["background"] = layers.join(", ");
    } else if (img) {
      // The plugin exports the container's photo fill as a real background
      // image (children hidden during export); inject it here as a bg-image.
      // scaleMode governs sizing/repeat: FIT → contain, TILE → repeat.
      const mode = img.scaleMode;
      if (mode === "FIT") cls.push("bg-contain", "bg-no-repeat", "bg-center");
      else if (mode === "TILE") cls.push("bg-repeat");
      else cls.push("bg-cover", "bg-center");
      el.style["background-image"] = `url(@@ASSET:${node.id}@@)`;
      el.style["background-color"] = "#e5e7eb"; // shown until the asset loads
      assets.push({ id: node.id, kind: "png", className: "", name: node.name });
    } else if (solidPaint) {
      cls.push(colorClass("bg", solidPaint.value, opts.tokens, solidPaint.variableName));
    }
  }

  // ---- Strokes / border ----
  const strokePaint = firstSolidPaint(node.strokes);
  const stroke = strokePaint?.value ?? null;
  const strokeGrad = !stroke
    ? (node.strokes ?? []).find(
        (f) => f.visible !== false && f.type.startsWith("GRADIENT"),
      )
    : undefined;
  if (strokeGrad) {
    // A gradient stroke isn't a border-color; border-image paints it. It does
    // not follow rounded corners, so say so rather than shipping a silent
    // mismatch.
    const gcss = gradientCss(strokeGrad, geo?.width ?? 0, geo?.height ?? 0);
    const wgt =
      node.strokeWeight ??
      Math.max(
        node.individualStrokeWeights?.top ?? 0,
        node.individualStrokeWeights?.right ?? 0,
        node.individualStrokeWeights?.bottom ?? 0,
        node.individualStrokeWeights?.left ?? 0,
      );
    if (gcss && wgt) {
      el.style["border"] = `${r(wgt)}px solid transparent`;
      el.style["border-image"] = `${gcss} 1`;
      if (node.cornerRadius || node.rectangleCornerRadii?.some(Boolean))
        warn(opts, node, "градиентная обводка не повторяет скругление углов");
    }
  } else if (stroke) {
    const isw = node.individualStrokeWeights;
    // A Figma stroke never consumes layout space, whatever its alignment; a CSS
    // border does (border-box shrinks the content area). On a container that
    // difference is not cosmetic: children sized to the full width — a row of
    // cards adding up to exactly 1340px — no longer fit and wrap onto the next
    // line. An outline is drawn without touching the box, and a negative offset
    // puts it where Figma draws it.
    const uniform = !!node.strokeWeight;
    const outlined =
      uniform && (node.strokeAlign === "OUTSIDE" || !!node.children?.length);
    if (outlined) {
      const kind = node.strokeDashes?.length ? "dashed" : "solid";
      const w = node.strokeWeight!;
      el.style["outline"] = `${r(w)}px ${kind} ${stroke}`;
      // OUTSIDE sits beyond the edge, INSIDE within it, CENTER straddles it.
      const offset =
        node.strokeAlign === "OUTSIDE" ? 0 : node.strokeAlign === "CENTER" ? -w / 2 : -w;
      el.style["outline-offset"] = `${r(offset)}px`;
    } else {
      let hasBorder = false;
      if (node.strokeWeight) {
        cls.push(`border-[${r(node.strokeWeight)}px]`);
        hasBorder = true;
      } else if (isw && (isw.top || isw.right || isw.bottom || isw.left)) {
        // Mixed per-side weights (e.g. an underline-only input field).
        if (isw.top) cls.push(`border-t-[${r(isw.top)}px]`);
        if (isw.right) cls.push(`border-r-[${r(isw.right)}px]`);
        if (isw.bottom) cls.push(`border-b-[${r(isw.bottom)}px]`);
        if (isw.left) cls.push(`border-l-[${r(isw.left)}px]`);
        hasBorder = true;
      }
      if (hasBorder) {
        cls.push(node.strokeDashes?.length ? "border-dashed" : "border-solid");
        cls.push(colorClass("border", stroke, opts.tokens, strokePaint?.variableName));
      }
    }
  }

  // ---- Clip ----
  if (node.clipsContent) cls.push("overflow-hidden");

  // ---- Rotation ----
  if (node.rotation && Math.abs(node.rotation) > 0.5) {
    cls.push(`rotate-[${+node.rotation.toFixed(1)}deg]`);
  }

  // ---- Text ----
  if (isText) {
    el.tag = "p";
    const s = node.style ?? {};

    // Mixed styling (a bold word, a coloured link inside a paragraph) arrives
    // as styledSegments — emit each run as a <span> so the emphasis survives.
    const segs = node.styledSegments;
    const baseFamily = s.fontFamily;
    const baseWeight = s.fontWeight;
    const baseSize = s.fontSize;
    if (segs && segs.length > 1) {
      for (const seg of segs) {
        const span: IRElement = {
          tag: "span",
          classes: [],
          style: {},
          children: [],
          name: node.name,
          text: seg.characters,
        };
        const sc = span.classes;
        if (seg.fontSize && seg.fontSize !== baseSize)
          sc.push(`text-[${r(seg.fontSize)}px]`);
        if (seg.fontWeight && seg.fontWeight !== baseWeight)
          sc.push(`font-[${seg.fontWeight}]`);
        if (seg.fontFamily && seg.fontFamily !== baseFamily) {
          const fname = opts.tokens?.font.get(seg.fontFamily);
          sc.push(fname ? `font-${fname}` : `font-['${seg.fontFamily.replace(/\s+/g, "_")}']`);
        }
        if (seg.italic) sc.push("italic");
        if (seg.textDecoration === "UNDERLINE") sc.push("underline");
        if (seg.color) sc.push(colorClass("text", seg.color, opts.tokens));
        // A hyperlinked run becomes a real inline <a href> inside the paragraph.
        if (seg.href) {
          span.tag = "a";
          span.attrs = { href: seg.href };
          if (!sc.includes("underline")) sc.push("underline");
        }
        el.children.push(span);
      }
    } else {
      el.text = node.characters ?? "";
    }
    if (s.fontSizeVar) cls.push(`text-${s.fontSizeVar}`);
    else if (s.fontSize) cls.push(`text-[${r(s.fontSize)}px]`);
    if (s.fontWeight) cls.push(`font-[${s.fontWeight}]`);
    if (s.lineHeightPx) cls.push(`leading-[${r(s.lineHeightPx)}px]`);
    if (s.letterSpacing) cls.push(`tracking-[${+s.letterSpacing.toFixed(2)}px]`);
    if (s.fontFamily) {
      const fname = opts.tokens?.font.get(s.fontFamily);
      cls.push(fname ? `font-${fname}` : `font-['${s.fontFamily.replace(/\s+/g, "_")}']`);
    }
    if (s.textAlignHorizontal === "CENTER") cls.push("text-center");
    else if (s.textAlignHorizontal === "RIGHT") cls.push("text-right");
    else if (s.textAlignHorizontal === "JUSTIFIED") cls.push("text-justify");
    // Vertical alignment inside a fixed-height text box → a flex column that
    // parks the copy at the top / middle / bottom (matches Figma's text box).
    if (s.textAlignVertical === "CENTER") cls.push("flex", "flex-col", "justify-center");
    else if (s.textAlignVertical === "BOTTOM") cls.push("flex", "flex-col", "justify-end");
    if (s.italic) cls.push("italic");
    if (s.textDecoration === "UNDERLINE") cls.push("underline");
    if (s.textCase === "UPPER") cls.push("uppercase");
    else if (s.textCase === "LOWER") cls.push("lowercase");
    // Truncation: single-line ellipsis (truncate) or a multi-line clamp.
    if (node.textTruncate === "ENDING") {
      if (node.maxLines && node.maxLines > 1) cls.push(`line-clamp-${node.maxLines}`);
      else cls.push("truncate");
    }
    // Soft-wrap detection: Figma wraps text at the box width without putting
    // "\n" into characters. When the box is taller than the explicit line count
    // explains (rendered lines > "\n"-lines), the text IS wrapping — it must
    // get its box width in CSS or the browser re-wraps it at the wrong points
    // (and whitespace-nowrap would overflow onto the neighbours).
    const explicitLines = (node.characters ?? "").split("\n").length;
    const lineH = s.lineHeightPx || (s.fontSize ? s.fontSize * 1.2 : 0);
    const softWraps =
      !!geo && lineH > 0 && Math.round(geo.height / lineH) > explicitLines;
    // Fixed-width text (Figma autoResize HEIGHT/NONE) wraps at its box width;
    // without a width the copy renders on one line and overflows the layout.
    // Content-hugging text (WIDTH_AND_HEIGHT) is left width-less.
    const fixedWidthText =
      node.textAutoResize === "NONE" ||
      node.textAutoResize === "HEIGHT" ||
      softWraps;
    if (fixedWidthText && geo && !fillW && !constraintNoW)
      cls.push(`w-[${r(geo.width)}px]`);
    // Content-hugging text (autoResize WIDTH_AND_HEIGHT) sizes to its content and
    // never wraps in Figma. Without a width the browser wraps it to whatever room
    // is left — which is tiny when the node is centered (left-1/2 -translate-x-1/2)
    // or otherwise pinned mid-parent. whitespace-nowrap reproduces the hug.
    else if (node.textAutoResize === "WIDTH_AND_HEIGHT")
      cls.push("whitespace-nowrap");
    // Figma laid this line out without wrapping (its box is exactly one line
    // tall), so the browser must not wrap it either: a box stretched to a
    // parent a few px narrower than the glyphs would otherwise break a value
    // like "7 200" across two lines and overlap whatever sits below.
    if (
      !softWraps &&
      geo &&
      lineH > 0 &&
      explicitLines === 1 &&
      Math.round(geo.height / lineH) <= 1 &&
      !cls.includes("whitespace-nowrap")
    )
      cls.push("whitespace-nowrap");
    // Bound to a component TEXT property → render `{propName}` in the JSX.
    if (node.textProp) {
      const pn = propIdent(node.textProp);
      if (opts.propNames?.has(pn)) el.textProp = pn;
    }
    const colorPaint = firstSolidPaint(node.fills);
    // A gradient-filled text node has no solid colour at all — painting the
    // gradient behind the glyphs and clipping it to them is the only way to
    // keep it (otherwise the text falls back to black).
    const textGrad = (node.fills ?? []).find(
      (f) => f.visible !== false && f.type.startsWith("GRADIENT"),
    );
    const textGradCss = textGrad
      ? gradientCss(textGrad, geo?.width ?? 0, geo?.height ?? 0)
      : null;
    if (textGradCss) {
      el.style["background-image"] = textGradCss;
      cls.push("bg-clip-text", "text-transparent");
    } else if (colorPaint)
      cls.push(colorClass("text", colorPaint.value, opts.tokens, colorPaint.variableName));
  }

  // ---- Children ----
  if (!isText && node.children) {
    // A masked group that also holds text can't be flattened (that would burn
    // the copy into a picture), and CSS can't clip to a vector — say so, since
    // the masked layers render unclipped.
    if (hasMaskedChild(node))
      warn(
        opts,
        node,
        "векторная маска не воспроизводится в CSS — слои отрисованы без обрезки",
      );
    for (const child of node.children) {
      const c = nodeToIR(child, node, opts, assets);
      if (c) el.children.push(c);
    }
  }

  // ---- List semantics: a run of look-alike auto-layout children → <ul>/<li> ----
  // The flex container keeps its classes; each item just swaps div→li (a flex
  // item's display is blockified, so the list marker never disturbs layout).
  if (
    opts.semantic &&
    el.tag === "div" &&
    isAutoLayout &&
    el.children.length >= 3 &&
    // Only real content cards (div wrappers with their own content) become a
    // list — never a row of bare icons/images, which stay a plain flex row.
    el.children.every((c) => c.tag === "div" && c.children.length > 0) &&
    looksLikeList(el.children)
  ) {
    el.tag = "ul";
    for (const c of el.children) c.tag = "li";
  }

  // ---- Semantic tag (button / h1-h6 / a / landmarks) ----
  // A real prototype reaction is far more reliable than the name-regex guess:
  // OPEN_URL → <a href>, any other click reaction → <button>.
  if (opts.semantic) {
    if (isText) {
      if (node.href) {
        el.tag = "a";
        el.attrs = { ...el.attrs, href: node.href };
      } else {
        const h = headingTag(node, opts.textSizes);
        if (h) el.tag = h;
        else if (isLinkNode(node)) {
          el.tag = "a";
          el.attrs = { ...el.attrs, href: "#" };
        }
      }
    } else if (el.tag === "div") {
      if (node.href) {
        el.tag = "a";
        el.attrs = { ...el.attrs, href: node.href };
      } else if (node.clickable || isButtonNode(node)) {
        el.tag = "button";
        el.attrs = { ...el.attrs, type: "button" };
      } else if (isLinkNode(node)) {
        el.tag = "a";
        el.attrs = { ...el.attrs, href: "#" };
      } else {
        const lm = landmarkTag(node);
        if (lm) el.tag = lm;
      }
      // An icon-only control (no text) needs an accessible name from its layer.
      if ((el.tag === "button" || el.tag === "a") && !subtreeHasText(node)) {
        const label = (node.name || "").trim();
        if (label && !/^(frame|group|rectangle|vector)\b/i.test(label))
          el.attrs = { "aria-label": label, ...el.attrs };
      }
    }
  }

  // ---- Responsive root: a hard-pixel canvas overflows narrow viewports.
  // Turn the top-level block's fixed width into a fluid one (w-full capped by
  // max-w) that centres itself, so the component adapts down to mobile. Only the
  // root — inner absolute children still need their pixel geometry.
  if (!parent && opts.responsive) {
    const wi = cls.findIndex((c) => /^w-\[\d+px\]$/.test(c));
    if (wi >= 0) {
      const w = /^w-\[(\d+)px\]$/.exec(cls[wi])![1];
      cls.splice(wi, 1, "w-full", `max-w-[${w}px]`, "mx-auto");
    }
  }

  // ---- Layer provenance: carry the designer's own naming into the markup so
  // the generated tree stays greppable against the Figma file.
  if (opts.layerNames) {
    const label = (node.name ?? "").trim();
    if (label) el.attrs = { ...el.attrs, "data-name": label };
    const styleName =
      node.style?.textStyleName ?? node.fillStyleName ?? node.effectStyleName;
    if (styleName) el.attrs = { ...el.attrs, "data-style": styleName };
  }

  return el;
}

/**
 * Do this auto-layout frame's children need more room along its primary axis
 * than the frame has? Figma allows that (and clips); flexbox does not, and the
 * overflow lands on whichever side the justification pushes it. See the call
 * site.
 */
function overflowsPrimaryAxis(node: FigmaNode): boolean {
  const box = node.absoluteBoundingBox;
  if (!box) return false;
  const horiz = node.layoutMode === "HORIZONTAL";
  const kids = (node.children ?? []).filter(
    (c) => c.visible !== false && c.layoutPositioning !== "ABSOLUTE",
  );
  if (!kids.length) return false;
  let need =
    (node.itemSpacing ?? 0) * (kids.length - 1) +
    (horiz
      ? (node.paddingLeft ?? 0) + (node.paddingRight ?? 0)
      : (node.paddingTop ?? 0) + (node.paddingBottom ?? 0));
  for (const c of kids) {
    const b = c.absoluteBoundingBox;
    // A child that stretches or hugs cannot be measured from its box alone.
    if (!b || (horiz ? c.layoutSizingHorizontal : c.layoutSizingVertical) === "FILL")
      return false;
    need += horiz ? b.width : b.height;
  }
  return need > (horiz ? box.width : box.height) + 0.5;
}

function axisToJustify(a?: string): string | null {
  switch (a) {
    case "CENTER":
      return "justify-center";
    case "MAX":
      return "justify-end";
    case "SPACE_BETWEEN":
      return "justify-between";
    case "MIN":
      return "justify-start";
    default:
      return null;
  }
}

function axisToAlign(a?: string): string | null {
  switch (a) {
    case "CENTER":
      return "items-center";
    case "MAX":
      return "items-end";
    case "MIN":
      return "items-start";
    case "BASELINE":
      return "items-baseline";
    default:
      return null;
  }
}

// ----------------- Serialization -----------------

/** "Show Icon#2:1" → "showIcon"; a component-property key → a JS identifier. */
function propIdent(raw: string): string {
  const base = raw.split("#")[0];
  const words = base.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "prop";
  const id = words
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toLowerCase() + w.slice(1)
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join("");
  return /^[a-z]/i.test(id) ? id : `prop${id}`;
}

function pascalCase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const pascal = cleaned
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(pascal) ? pascal : `Component${pascal}`;
}

function escapeJsxText(t: string): string {
  return t.replace(/[{}]/g, (m) => `{'${m}'}`);
}

function styleToJsx(style: Record<string, string>): string {
  const entries = Object.entries(style);
  if (!entries.length) return "";
  const body = entries
    .map(([k, v]) => {
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return `${key}: ${JSON.stringify(v)}`;
    })
    .join(", ");
  return ` style={{ ${body} }}`;
}

function attrsStr(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
}

/** Provenance attributes are labels, not structure - two list items named
 * "Card 1" / "Card 2" are still the same shape. */
function structAttrs(attrs?: Record<string, string>): Record<string, string> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs))
    if (k !== "data-name" && k !== "data-style") out[k] = v;
  return out;
}

/** A structural fingerprint of an element that ignores text *content* (but not
 * its presence) — two elements with the same key differ only in what they say. */
function structKey(el: IRElement): string {
  return (
    el.tag +
    "|" +
    el.classes.join(",") +
    "|" +
    JSON.stringify(el.style) +
    "|" +
    JSON.stringify(structAttrs(el.attrs)) +
    (el.asset ? "#A" : "") +
    (el.svg ? "#S" + JSON.stringify(el.svg) : "") +
    (el.text != null ? "#T" : "") +
    "(" +
    el.children.map(structKey).join("") +
    ")"
  );
}

/** A run of siblings that share one structure — candidates for <ul> / .map(). */
function looksLikeList(children: IRElement[]): boolean {
  if (children.length < 3) return false;
  const k0 = structKey(children[0]);
  return children.every((c) => structKey(c) === k0);
}

function cloneIR(el: IRElement): IRElement {
  return {
    ...el,
    classes: [...el.classes],
    style: { ...el.style },
    attrs: el.attrs ? { ...el.attrs } : undefined,
    children: el.children.map(cloneIR),
  };
}

/** Text leaves of an element, in document order (the fields of a list item). */
function textLeaves(el: IRElement): IRElement[] {
  if (el.text != null && !el.children.length) return [el];
  return el.children.flatMap(textLeaves);
}

/**
 * When every child shares one structure and differs only in its text, collapse
 * them into a single `.map()` over an item-data array — the way a developer
 * would actually write a list. JSX output only; HTML/Vue keep the flat markup.
 */
function serializeMappedChildren(children: IRElement[], indent: number): string | null {
  if (!looksLikeList(children)) return null;
  const perItem = children.map(textLeaves);
  const n = perItem[0].length;
  const varying: number[] = [];
  for (let i = 0; i < n; i++) {
    const vals = perItem.map((leaves) => leaves[i].text ?? "");
    if (vals.some((v) => v !== vals[0])) varying.push(i);
  }
  if (!varying.length) return null; // identical items — a plain repeat, skip

  const used = new Set<string>();
  const field: Record<number, string> = {};
  varying.forEach((idx, k) => {
    let base = propIdent(perItem[0][idx].name || `field${k + 1}`);
    if (!/^[a-z]/i.test(base)) base = `field${k + 1}`;
    let u = base;
    let j = 2;
    while (used.has(u)) u = `${base}${j++}`;
    used.add(u);
    field[idx] = u;
  });

  const pad = "  ".repeat(indent);
  const items = perItem
    .map((leaves) => {
      const body = varying
        .map((idx) => `${field[idx]}: ${JSON.stringify(leaves[idx].text ?? "")}`)
        .join(", ");
      return `${pad}  { ${body} },`;
    })
    .join("\n");

  const tmpl = cloneIR(children[0]);
  const tLeaves = textLeaves(tmpl);
  for (const idx of varying) tLeaves[idx].textProp = `item.${field[idx]}`;
  tmpl.attrs = { "data-mapkey": "__MAPKEY__", ...tmpl.attrs };
  const body = serialize(tmpl, indent + 1).replace('data-mapkey="__MAPKEY__"', "key={i}");
  return `${pad}{[\n${items}\n${pad}].map((item, i) => (\n${body}\n${pad}))}`;
}

function serialize(el: IRElement, indent: number): string {
  const pad = "  ".repeat(indent);
  // INSTANCE_SWAP slot → a ReactNode prop stands in for the whole subtree.
  if (el.slotProp) return `${pad}{${el.slotProp}}`;
  // BOOLEAN prop → render the element only when the prop is truthy.
  if (el.condProp) {
    return `${pad}{${el.condProp} && (\n${serializeCore(el, indent + 1)}\n${pad})}`;
  }
  return serializeCore(el, indent);
}

function serializeCore(el: IRElement, indent: number): string {
  const pad = "  ".repeat(indent);
  const className = el.classes.length ? ` className="${el.classes.join(" ")}"` : "";
  const style = styleToJsx(el.style);
  const attrs = attrsStr(el.attrs);

  if (el.text != null && !el.children.length) {
    // A text node bound to a component TEXT property renders as `{prop}`.
    if (el.textProp) {
      return `${pad}<${el.tag}${className}${style}${attrs}>{${el.textProp}}</${el.tag}>`;
    }
    const text = escapeJsxText(el.text);
    if (text.includes("\n")) {
      return `${pad}<${el.tag}${className}${style}${attrs}>\n${pad}  ${text.replace(/\n/g, `<br />\n${pad}  `)}\n${pad}</${el.tag}>`;
    }
    return `${pad}<${el.tag}${className}${style}${attrs}>${text}</${el.tag}>`;
  }

  if (el.svg) {
    return `${pad}<svg${className}${style} viewBox="${el.svg.viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${svgPaths(el.svg.shapes, true)}</svg>`;
  }

  if (el.asset) {
    return `${pad}<img${className}${style} src="@@ASSET:${el.asset.id}@@" alt="${el.name.replace(/"/g, "")}" />`;
  }

  if (!el.children.length) {
    return `${pad}<${el.tag}${className}${style}${attrs} />`;
  }

  // Inline text runs (styled <span> segments) — a newline between them would
  // collapse to a stray space and split words that Figma kept together.
  if (isInlineTextRuns(el)) {
    const inner = el.children.map((c) => serializeInline(c)).join("");
    return `${pad}<${el.tag}${className}${style}${attrs}>${inner}</${el.tag}>`;
  }

  // Look-alike children differing only in text → a single .map() (JSX only).
  const mapped = serializeMappedChildren(el.children, indent + 1);
  if (mapped) {
    return `${pad}<${el.tag}${className}${style}${attrs}>\n${mapped}\n${pad}</${el.tag}>`;
  }

  const inner = el.children.map((c) => serialize(c, indent + 1)).join("\n");
  return `${pad}<${el.tag}${className}${style}${attrs}>\n${inner}\n${pad}</${el.tag}>`;
}

/** Render generated shapes as SVG children (JSX camel-cases stroke-width). */
function svgPaths(shapes: SvgShape[], jsx: boolean): string {
  return shapes
    .map((sh) => {
      const cap = sh.linecap
        ? jsx
          ? ` strokeLinecap="${sh.linecap}"`
          : ` stroke-linecap="${sh.linecap}"`
        : "";
      const stroke = sh.stroke
        ? ` stroke="${sh.stroke}"${
            sh.strokeWidth != null
              ? jsx
                ? ` strokeWidth="${sh.strokeWidth}"`
                : ` stroke-width="${sh.strokeWidth}"`
              : ""
          }${cap}`
        : "";
      return `<path d="${sh.d}" fill="${sh.fill}"${stroke} />`;
    })
    .join("");
}

/** True when every child is a plain-text leaf run (a styled <span>/<a> segment). */
function isInlineTextRuns(el: IRElement): boolean {
  return (
    el.children.length > 0 &&
    el.children.every(
      (c) => (c.tag === "span" || c.tag === "a") && c.text != null && !c.children.length,
    )
  );
}

/**
 * A styled run keeps its line breaks like any other text: a raw newline inside
 * a <span> collapses to a space, silently joining two lines of a caption into
 * one. The plain-text paths already do this — the inline ones must match.
 */
const breakLines = (t: string) => t.replace(/\n/g, "<br />");

function serializeInline(el: IRElement): string {
  const className = el.classes.length ? ` className="${el.classes.join(" ")}"` : "";
  const style = styleToJsx(el.style);
  const attrs = attrsStr(el.attrs);
  return `<${el.tag}${className}${style}${attrs}>${breakLines(escapeJsxText(el.text ?? ""))}</${el.tag}>`;
}

function serializeInlineHtml(el: IRElement): string {
  const className = el.classes.length ? ` class="${el.classes.join(" ")}"` : "";
  const style = styleToHtml(el.style);
  const attrs = attrsStr(el.attrs);
  return `<${el.tag}${className}${style}${attrs}>${breakLines(escapeHtml(el.text ?? ""))}</${el.tag}>`;
}

function styleToHtml(style: Record<string, string>): string {
  const entries = Object.entries(style);
  if (!entries.length) return "";
  const body = entries.map(([k, v]) => `${k}: ${v}`).join("; ");
  return ` style="${body.replace(/"/g, "&quot;")}"`;
}

function escapeHtml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function serializeHtml(el: IRElement, indent: number): string {
  const pad = "  ".repeat(indent);
  const className = el.classes.length ? ` class="${el.classes.join(" ")}"` : "";
  const style = styleToHtml(el.style);
  const attrs = attrsStr(el.attrs);
  const tag = el.tag;

  if (el.text != null && !el.children.length) {
    const text = escapeHtml(el.text).replace(/\n/g, "<br />");
    return `${pad}<${tag}${className}${style}${attrs}>${text}</${tag}>`;
  }
  if (el.svg) {
    return `${pad}<svg${className}${style} viewBox="${el.svg.viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${svgPaths(el.svg.shapes, false)}</svg>`;
  }
  if (el.asset) {
    return `${pad}<img${className}${style} src="@@ASSET:${el.asset.id}@@" alt="${escapeHtml(el.name)}" />`;
  }
  if (!el.children.length) {
    return `${pad}<${tag}${className}${style}${attrs}></${tag}>`;
  }
  if (isInlineTextRuns(el)) {
    const inner = el.children.map((c) => serializeInlineHtml(c)).join("");
    return `${pad}<${tag}${className}${style}${attrs}>${inner}</${tag}>`;
  }
  const inner = el.children.map((c) => serializeHtml(c, indent + 1)).join("\n");
  return `${pad}<${tag}${className}${style}${attrs}>\n${inner}\n${pad}</${tag}>`;
}

export interface ConvertResult {
  componentName: string;
  jsx: string;
  code: string;
  html: string;
  /** Vue 3 single-file component (<template> + <script setup>) */
  vue: string;
  /** CSS-modules variant: component JSX + the .module.css it imports */
  cssModule: { jsx: string; css: string };
  /** assets (icons/images) referenced via @@ASSET:<id>@@ placeholders */
  assets: AssetRef[];
  /** Tailwind v4 @theme block when token mode is on (paste into globals.css) */
  themeCss?: string;
  /** palette/fonts for the live preview's Tailwind config */
  previewTheme?: PreviewTheme;
  /** non-fatal notes about lossy/unsupported features (graceful degradation) */
  warnings?: string[];
}

// ----------------- Vue SFC -----------------

function wrapVue(innerHtml: string, name: string): string {
  return `<template>\n${innerHtml}\n</template>\n\n<script setup lang="ts">\n// ${name}\n</script>\n`;
}

// ----------------- CSS modules -----------------

/** Resolve a single Tailwind utility we emit back into CSS declarations. */
function twDecls(
  classes: string[],
  theme?: PreviewTheme | null,
): Record<string, string> {
  const d: Record<string, string> = {};
  const colorOf = (name: string) => theme?.colors?.[name];
  const fontOf = (name: string) => theme?.fontFamily?.[name];
  const spaceOf = (name: string) => theme?.spacing?.[name];
  const radiusOf = (name: string) => theme?.borderRadius?.[name];
  const sizeOf = (name: string) => theme?.fontSize?.[name];
  for (const c of classes) {
    const m = /\[(.+)\]$/.exec(c);
    const arb = m ? m[1] : null;
    // static utilities
    if (c === "absolute") d.position = "absolute";
    else if (c === "relative") d.position = "relative";
    else if (c === "flex") d.display = "flex";
    else if (c === "flex-col") d["flex-direction"] = "column";
    else if (c === "flex-wrap") d["flex-wrap"] = "wrap";
    else if (c === "grow") d["flex-grow"] = "1";
    else if (c === "shrink-0") d["flex-shrink"] = "0";
    else if (c === "self-stretch") d["align-self"] = "stretch";
    else if (c === "w-full") d.width = "100%";
    else if (c === "object-contain") d["object-fit"] = "contain";
    else if (c === "object-cover") d["object-fit"] = "cover";
    else if (c === "bg-cover") d["background-size"] = "cover";
    else if (c === "bg-center") d["background-position"] = "center";
    else if (c === "overflow-hidden") d.overflow = "hidden";
    else if (c === "isolate") d.isolation = "isolate";
    else if (c === "-z-10") d["z-index"] = "-10";
    else if (c === "bg-contain") d["background-size"] = "contain";
    else if (c === "bg-no-repeat") d["background-repeat"] = "no-repeat";
    else if (c === "bg-repeat") d["background-repeat"] = "repeat";
    else if (c === "truncate") {
      d.overflow = "hidden";
      d["text-overflow"] = "ellipsis";
      d["white-space"] = "nowrap";
    } else if (/^line-clamp-\d+$/.test(c)) {
      d.display = "-webkit-box";
      d["-webkit-line-clamp"] = c.slice("line-clamp-".length);
      d["-webkit-box-orient"] = "vertical";
      d.overflow = "hidden";
    }
    else if (c.startsWith("mix-blend-")) d["mix-blend-mode"] = c.slice("mix-blend-".length);
    else if (c === "italic") d["font-style"] = "italic";
    else if (c === "underline") d["text-decoration"] = "underline";
    else if (c === "uppercase") d["text-transform"] = "uppercase";
    else if (c === "lowercase") d["text-transform"] = "lowercase";
    else if (c === "text-center") d["text-align"] = "center";
    else if (c === "text-right") d["text-align"] = "right";
    else if (c === "text-justify") d["text-align"] = "justify";
    else if (c === "border-solid") d["border-style"] = "solid";
    else if (c === "border-dashed") d["border-style"] = "dashed";
    else if (c === "rounded-full") d["border-radius"] = "9999px";
    else if (c === "justify-center") d["justify-content"] = "center";
    else if (c === "justify-end") d["justify-content"] = "flex-end";
    else if (c === "justify-between") d["justify-content"] = "space-between";
    else if (c === "justify-start") d["justify-content"] = "flex-start";
    else if (c === "items-center") d["align-items"] = "center";
    else if (c === "items-end") d["align-items"] = "flex-end";
    else if (c === "items-start") d["align-items"] = "flex-start";
    else if (c === "items-baseline") d["align-items"] = "baseline";
    // arbitrary-value utilities: prop-[value]
    else if (arb && c.startsWith("left-[")) d.left = arb;
    else if (arb && c.startsWith("top-[")) d.top = arb;
    else if (arb && c.startsWith("gap-x-[")) d["column-gap"] = arb;
    else if (arb && c.startsWith("gap-y-[")) d["row-gap"] = arb;
    else if (arb && c.startsWith("gap-[")) d.gap = arb;
    else if (arb && c.startsWith("w-[")) d.width = arb;
    else if (arb && c.startsWith("h-[")) d.height = arb;
    else if (arb && c.startsWith("min-w-[")) d["min-width"] = arb;
    else if (arb && c.startsWith("max-w-[")) d["max-width"] = arb;
    else if (arb && c.startsWith("min-h-[")) d["min-height"] = arb;
    else if (arb && c.startsWith("max-h-[")) d["max-height"] = arb;
    else if (arb && c.startsWith("p-[")) d.padding = arb;
    else if (arb && c.startsWith("px-[")) {
      d["padding-left"] = arb;
      d["padding-right"] = arb;
    } else if (arb && c.startsWith("py-[")) {
      d["padding-top"] = arb;
      d["padding-bottom"] = arb;
    } else if (arb && c.startsWith("pt-[")) d["padding-top"] = arb;
    else if (arb && c.startsWith("pr-[")) d["padding-right"] = arb;
    else if (arb && c.startsWith("pb-[")) d["padding-bottom"] = arb;
    else if (arb && c.startsWith("pl-[")) d["padding-left"] = arb;
    else if (arb && c.startsWith("rounded-[")) d["border-radius"] = arb;
    else if (arb && c.startsWith("rounded-tl-[")) d["border-top-left-radius"] = arb;
    else if (arb && c.startsWith("rounded-tr-[")) d["border-top-right-radius"] = arb;
    else if (arb && c.startsWith("rounded-br-[")) d["border-bottom-right-radius"] = arb;
    else if (arb && c.startsWith("rounded-bl-[")) d["border-bottom-left-radius"] = arb;
    else if (arb && c.startsWith("border-[")) {
      // border-[2px] → width; border-[#fff] → color
      if (/^#|^rgb/.test(arb)) d["border-color"] = arb;
      else d["border-width"] = arb;
    } else if (arb && c.startsWith("border-t-[")) d["border-top-width"] = arb;
    else if (arb && c.startsWith("border-r-[")) d["border-right-width"] = arb;
    else if (arb && c.startsWith("border-b-[")) d["border-bottom-width"] = arb;
    else if (arb && c.startsWith("border-l-[")) d["border-left-width"] = arb;
    else if (arb && c.startsWith("opacity-[")) d.opacity = arb;
    else if (arb && c.startsWith("leading-[")) d["line-height"] = arb;
    else if (arb && c.startsWith("tracking-[")) d["letter-spacing"] = arb;
    else if (arb && c.startsWith("font-[")) {
      // font-[700] → weight; font-['Inter'] → family
      if (/^\d+$/.test(arb)) d["font-weight"] = arb;
      else d["font-family"] = arb.replace(/^'|'$/g, "").replace(/_/g, " ");
    } else if (arb && c.startsWith("shadow-[")) d["box-shadow"] = arb.replace(/_/g, " ");
    else if (arb && c.startsWith("blur-[")) d.filter = `blur(${arb})`;
    else if (arb && c.startsWith("backdrop-blur-[")) d["backdrop-filter"] = `blur(${arb})`;
    else if (arb && c.startsWith("rotate-[")) d.transform = `rotate(${arb})`;
    else if (arb && c.startsWith("bg-[")) d["background-color"] = arb;
    else if (arb && c.startsWith("text-[")) {
      if (/^#|^rgb/.test(arb)) d.color = arb;
      else d["font-size"] = arb;
    }
    // variable token utilities: gap-md, p-lg, rounded-md (from Figma variables)
    else if (c.startsWith("gap-")) {
      const v = spaceOf(c.slice(4));
      if (v) d.gap = v;
    } else if (c.startsWith("px-")) {
      const v = spaceOf(c.slice(3));
      if (v) { d["padding-left"] = v; d["padding-right"] = v; }
    } else if (c.startsWith("py-")) {
      const v = spaceOf(c.slice(3));
      if (v) { d["padding-top"] = v; d["padding-bottom"] = v; }
    } else if (c.startsWith("pt-")) {
      const v = spaceOf(c.slice(3)); if (v) d["padding-top"] = v;
    } else if (c.startsWith("pr-")) {
      const v = spaceOf(c.slice(3)); if (v) d["padding-right"] = v;
    } else if (c.startsWith("pb-")) {
      const v = spaceOf(c.slice(3)); if (v) d["padding-bottom"] = v;
    } else if (c.startsWith("pl-")) {
      const v = spaceOf(c.slice(3)); if (v) d["padding-left"] = v;
    } else if (c.startsWith("p-")) {
      const v = spaceOf(c.slice(2)); if (v) d.padding = v;
    } else if (c.startsWith("rounded-")) {
      const v = radiusOf(c.slice(8)); if (v) d["border-radius"] = v;
    }
    // token utilities: bg-purple-500, text-white, border-gray-dark, font-inter
    else if (c.startsWith("bg-")) {
      const v = colorOf(c.slice(3));
      if (v) d["background-color"] = v;
    } else if (c.startsWith("text-")) {
      const name = c.slice(5);
      const cv = colorOf(name);
      if (cv) d.color = cv;
      else {
        const sv = sizeOf(name);
        if (sv) d["font-size"] = sv;
      }
    } else if (c.startsWith("border-")) {
      const v = colorOf(c.slice(7));
      if (v) d["border-color"] = v;
    } else if (c.startsWith("font-")) {
      const v = fontOf(c.slice(5));
      if (v) d["font-family"] = v.join(", ");
    }
  }
  return d;
}

function cssIdent(base: string, used: Set<string>): string {
  let id = base
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
  if (!id || !/^[a-z]/i.test(id)) id = `el${id}`;
  let u = id;
  let i = 2;
  while (used.has(u)) u = `${id}${i++}`;
  used.add(u);
  return u;
}

interface CssModCtx {
  used: Set<string>;
  rules: string[];
  theme?: PreviewTheme | null;
}

/** Serialize one IR element to JSX that references CSS-module class names. */
function serializeCssMod(el: IRElement, indent: number, ctx: CssModCtx): string {
  const pad = "  ".repeat(indent);
  const decls = { ...twDecls(el.classes, ctx.theme), ...el.style };
  let classAttr = "";
  if (Object.keys(decls).length) {
    const name = cssIdent(el.name || el.tag, ctx.used);
    const body = Object.entries(decls)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    ctx.rules.push(`.${name} {\n${body}\n}`);
    classAttr = ` className={styles.${name}}`;
  }
  const attrs = attrsStr(el.attrs);

  if (el.svg) {
    return `${pad}<svg${classAttr} viewBox="${el.svg.viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${svgPaths(el.svg.shapes, true)}</svg>`;
  }
  if (el.asset) {
    return `${pad}<img${classAttr} src="@@ASSET:${el.asset.id}@@" alt="${el.name.replace(/"/g, "")}" />`;
  }
  if (el.text != null && !el.children.length) {
    const text = escapeJsxText(el.text);
    if (text.includes("\n")) {
      return `${pad}<${el.tag}${classAttr}${attrs}>\n${pad}  ${text.replace(/\n/g, `<br />\n${pad}  `)}\n${pad}</${el.tag}>`;
    }
    return `${pad}<${el.tag}${classAttr}${attrs}>${text}</${el.tag}>`;
  }
  if (!el.children.length) {
    return `${pad}<${el.tag}${classAttr}${attrs} />`;
  }
  const inner = el.children.map((c) => serializeCssMod(c, indent + 1, ctx)).join("\n");
  return `${pad}<${el.tag}${classAttr}${attrs}>\n${inner}\n${pad}</${el.tag}>`;
}

interface Root {
  name: string;
  ir: IRElement;
}

function buildCssModule(
  roots: Root[],
  componentName: string,
  theme?: PreviewTheme | null,
): { jsx: string; css: string } {
  const ctx: CssModCtx = { used: new Set(), rules: [], theme };
  const importLine = `import styles from "./${componentName}.module.css";\n\n`;

  if (roots.length === 1) {
    const body = serializeCssMod(roots[0].ir, 2, ctx);
    const jsx = `${importLine}export default function ${componentName}() {\n  return (\n${body}\n  );\n}\n`;
    return { jsx, css: ctx.rules.join("\n\n") + "\n" };
  }

  const used = new Set<string>();
  const fns = roots.map((root) => {
    let name = pascalCase(root.name || "FigmaComponent");
    let unique = name;
    let i = 2;
    while (used.has(unique)) unique = `${name}${i++}`;
    used.add(unique);
    name = unique;
    const body = serializeCssMod(root.ir, 2, ctx);
    return `export function ${name}() {\n  return (\n${body}\n  );\n}`;
  });
  const jsx = `${importLine}${fns.join("\n\n")}\n`;
  return { jsx, css: ctx.rules.join("\n\n") + "\n" };
}

/** Union bounding box of several nodes (for combined selections). */
function unionBBox(nodes: FigmaNode[]): FigmaRect | undefined {
  const boxes = nodes.map((n) => n.absoluteBoundingBox).filter(Boolean) as FigmaRect[];
  if (!boxes.length) return undefined;
  let x = Infinity,
    y = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const b of boxes) {
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Wrap several selected nodes in a synthetic non-auto-layout parent so the
 * existing converter lays them out (absolute-positioned) over their shared
 * bounding box — exactly as they sit in the Figma canvas.
 */
export function combineNodes(nodes: FigmaNode[]): FigmaNode {
  return {
    id: "selection",
    name: "Selection",
    type: "GROUP",
    layoutMode: "NONE",
    absoluteBoundingBox: unionBBox(nodes),
    children: nodes,
  };
}

/** Convert several nodes at once — either merged into one block or side by side. */
export function convertNodes(
  nodes: FigmaNode[],
  mode: "combine" | "separate",
  opts: ConvertOptions = { absolutePositioning: true },
): ConvertResult {
  const warnings = opts.warnings ?? [];
  opts = { ...opts, warnings };

  if (nodes.length === 1) return convertNode(nodes[0], opts);

  // Build one token context from the whole selection so every component
  // shares the same palette/font names.
  let themeCss: string | undefined;
  let previewTheme: PreviewTheme | undefined;
  if (opts.useTokens && !opts.tokens) {
    const ctx = buildTokenContext(combineNodes(nodes), opts.variables);
    opts = { ...opts, tokens: ctx.maps, previewTheme: ctx.previewTheme };
    themeCss = ctx.themeCss;
    previewTheme = ctx.previewTheme;
  }

  if (mode === "combine") {
    const r = convertNode(combineNodes(nodes), opts);
    return { ...r, themeCss: themeCss ?? r.themeCss, previewTheme: previewTheme ?? r.previewTheme };
  }

  // separate: independent components concatenated into one file.
  const assets: AssetRef[] = [];
  const usedNames = new Set<string>();
  const codes: string[] = [];
  const htmls: string[] = [];
  const vues: string[] = [];
  const roots: Root[] = [];
  for (const n of nodes) {
    const ir = nodeToIR(n, null, opts, assets);
    if (!ir) continue;
    let name = pascalCase(n.name || "FigmaComponent");
    let unique = name;
    let i = 2;
    while (usedNames.has(unique)) unique = `${name}${i++}`;
    usedNames.add(unique);
    name = unique;
    roots.push({ name: n.name || name, ir });
    const jsx = serialize(ir, 2);
    codes.push(
      `export function ${name}() {\n  return (\n${jsx}\n  );\n}`,
    );
    htmls.push(serializeHtml(ir, 0));
    vues.push(serializeHtml(ir, 2));
  }
  // de-dupe assets by id+kind
  const seen = new Set<string>();
  const uniqueAssets = assets.filter((a) => {
    const k = `${a.kind}:${a.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const vueInner = `  <div class="flex flex-col gap-6">\n${vues.join("\n")}\n  </div>`;
  return {
    componentName: "Selection",
    jsx: "",
    code: codes.join("\n\n") + "\n",
    html: `<div class="flex flex-col gap-6">\n${htmls.join("\n")}\n</div>`,
    vue: wrapVue(vueInner, "Selection"),
    cssModule: buildCssModule(roots, "Selection", previewTheme ?? opts.previewTheme),
    assets: uniqueAssets,
    themeCss,
    previewTheme,
    warnings: warnings.length ? [...new Set(warnings)] : undefined,
  };
}

/** Convert a Figma node into a self-contained React + Tailwind component. */
export function convertNode(
  node: FigmaNode,
  opts: ConvertOptions = { absolutePositioning: true },
): ConvertResult {
  // Shared warnings sink, threaded down via opts (survives the spreads below).
  const warnings = opts.warnings ?? [];
  opts = { ...opts, warnings };

  // Build the token context once, on the top-level call (nested calls inherit
  // it via opts.tokens so the maps aren't rebuilt per child).
  let themeCss: string | undefined;
  let previewTheme: PreviewTheme | undefined;
  if (opts.useTokens && !opts.tokens) {
    const ctx = buildTokenContext(node, opts.variables);
    opts = { ...opts, tokens: ctx.maps, previewTheme: ctx.previewTheme };
    themeCss = ctx.themeCss;
    previewTheme = ctx.previewTheme;
  }

  const componentName = pascalCase(node.componentName || node.name || "FigmaComponent");

  // Component properties → real, typed React props. TEXT binds a text node's
  // characters ({label}); BOOLEAN gates a subtree ({show && …}); INSTANCE_SWAP
  // becomes a ReactNode slot ({icon}). Built before nodeToIR so the bound nodes
  // can reference the prop instead of hard-coding the design-time value.
  const propDefs: { name: string; tsType: string; def: string | null }[] = [];
  const propNames = new Set<string>();
  let needsReactNode = false;
  for (const [key, def] of Object.entries(node.componentProperties ?? {})) {
    const name = propIdent(key);
    if (propNames.has(name)) continue;
    if (def.type === "TEXT") {
      propNames.add(name);
      propDefs.push({ name, tsType: "string", def: JSON.stringify(String(def.value ?? "")) });
    } else if (def.type === "BOOLEAN") {
      propNames.add(name);
      propDefs.push({
        name,
        tsType: "boolean",
        def: def.value === true || def.value === "true" ? "true" : "false",
      });
    } else if (def.type === "INSTANCE_SWAP") {
      propNames.add(name);
      needsReactNode = true;
      propDefs.push({ name, tsType: "ReactNode", def: null });
    }
  }
  if (propNames.size) opts = { ...opts, propNames };

  // Relative heading detection needs the palette of text sizes in the subtree.
  if (opts.semantic) {
    const sizes = new Set<number>();
    collectTextSizes(node, sizes);
    if (sizes.size) opts = { ...opts, textSizes: Array.from(sizes).sort((a, b) => b - a) };
  }

  const assets: AssetRef[] = [];
  const ir = nodeToIR(node, null, opts, assets);
  if (!ir) {
    const empty = `export default function ${componentName}() {\n  return null;\n}\n`;
    return {
      componentName,
      jsx: "null",
      code: empty,
      html: "",
      vue: "",
      cssModule: { jsx: "", css: "" },
      assets: [],
    };
  }
  const jsx = serialize(ir, 2);
  const html = serializeHtml(ir, 0);
  let propsType = "";
  let signature = "";
  if (propDefs.length) {
    const typeName = `${componentName}Props`;
    propsType =
      (needsReactNode ? `import type { ReactNode } from "react";\n\n` : "") +
      `interface ${typeName} {\n` +
      propDefs.map((p) => `  ${p.name}?: ${p.tsType};`).join("\n") +
      `\n}\n\n`;
    signature = `{ ${propDefs
      .map((p) => (p.def == null ? p.name : `${p.name} = ${p.def}`))
      .join(", ")} }: ${typeName}`;
  }
  const code = `${propsType}export default function ${componentName}(${signature}) {
  return (
${jsx}
  );
}
`;
  const vue = wrapVue(serializeHtml(ir, 1), componentName);
  const cssModule = buildCssModule(
    [{ name: componentName, ir }],
    componentName,
    previewTheme ?? opts.previewTheme,
  );
  return {
    componentName,
    jsx,
    code,
    html,
    vue,
    cssModule,
    assets,
    themeCss,
    previewTheme,
    warnings: warnings.length ? [...new Set(warnings)] : undefined,
  };
}
