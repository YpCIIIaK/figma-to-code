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
  // Honour an explicit "Export as SVG" mark from the designer — but never for a
  // photo container (that would embed the raster and bloat the output).
  if (n.svgExport && !hasImageFill(n)) return true;
  const container =
    n.type === "FRAME" ||
    n.type === "GROUP" ||
    n.type === "INSTANCE" ||
    n.type === "COMPONENT";
  if (container && n.children?.length) {
    // A photo (image fill) is never an icon — flattening it to SVG embeds the
    // raster and bloats the code; let it become a background image instead.
    if (hasImageFill(n)) return false;
    if (subtreeHasText(n)) return false;
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

function hasImageFill(n: FigmaNode): boolean {
  return (n.fills ?? []).some(
    (f) => f.visible !== false && f.type === "IMAGE",
  );
}

/** scaleMode of the first visible image fill (FILL / FIT / TILE / CROP). */
function imageScaleMode(n: FigmaNode): string | undefined {
  return (n.fills ?? []).find(
    (f) => f.visible !== false && f.type === "IMAGE",
  )?.scaleMode;
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
  const m = /\bh([1-6])\b/i.exec(n.name);
  if (m) return (`h${m[1]}` as IRTag);
  const named = /\b(heading|headline|title|заголовок)\b/i.test(n.name);
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

function gradientCss(p: FigmaPaint): string | null {
  if (!p.gradientStops?.length) return null;
  const stops = p.gradientStops
    .map((s) => `${colorToHex(s.color)} ${r(s.position * 100)}%`)
    .join(", ");
  if (p.type === "GRADIENT_RADIAL") {
    // Position/size the ellipse from Figma's handles: [0] centre, [1] end of the
    // horizontal radius, [2] end of the vertical radius (all normalised 0–1 to
    // the box). Without handles fall back to a centred circle.
    const h = p.gradientHandlePositions;
    if (h && h.length >= 3) {
      const cx = r(h[0].x * 100);
      const cy = r(h[0].y * 100);
      const rx = r(Math.hypot(h[1].x - h[0].x, h[1].y - h[0].y) * 100);
      const ry = r(Math.hypot(h[2].x - h[0].x, h[2].y - h[0].y) * 100);
      return `radial-gradient(ellipse ${rx}% ${ry}% at ${cx}% ${cy}%, ${stops})`;
    }
    return `radial-gradient(circle, ${stops})`;
  }
  // Prefer the real gradient angle (plugin computes it from the handle
  // positions); fall back to top-to-bottom for REST payloads that lack it.
  const angle = p.gradientAngle != null ? r(p.gradientAngle) : 180;
  return `linear-gradient(${angle}deg, ${stops})`;
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
function unrotatedRect(box: FigmaRect, cssRotationDeg: number): FigmaRect {
  const theta = (cssRotationDeg * Math.PI) / 180;
  const ac = Math.abs(Math.cos(theta));
  const as = Math.abs(Math.sin(theta));
  // The AABB (Wb,Hb) of a w×h rectangle rotated by θ satisfies:
  //   Wb = w·|cos| + h·|sin|,  Hb = w·|sin| + h·|cos|.
  // Solve for w,h. denom = |cos|²−|sin|² vanishes only near 45° (singular).
  const denom = ac * ac - as * as;
  if (Math.abs(denom) < 1e-4) return box;
  const w = (box.width * ac - box.height * as) / denom;
  const h = (box.height * ac - box.width * as) / denom;
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
  // Opt-in: adopt Figma's inferred auto-layout for a free-form frame so the
  // existing auto-layout→flex path fires (children flow instead of being pinned
  // with absolute left/top). Children are sorted along the primary axis because
  // Figma's children array is in z-order, not visual order.
  if (
    opts.inferLayout &&
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
  }

  const cls = el.classes;
  const box = bbox(node);
  // For a rotated node, position & size come from the un-rotated rectangle
  // (see unrotatedRect); `rotate()` is emitted separately below. Non-rotated
  // nodes use the bounding box unchanged.
  const rotDeg = node.rotation && Math.abs(node.rotation) > 0.5 ? node.rotation : 0;
  const geo = box && rotDeg ? unrotatedRect(box, rotDeg) : box;
  // unrotatedRect returns the AABB unchanged near ~45° (singular) — position
  // may be slightly off there; note it rather than fail silently.
  if (geo && box && rotDeg && geo.width === box.width && geo.height === box.height)
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
    if (node.itemSpacing)
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

    const justify = axisToJustify(node.primaryAxisAlignItems);
    if (justify) cls.push(justify);
    const align = axisToAlign(node.counterAxisAlignItems);
    if (align) cls.push(align);

    // Containing block for layoutPositioning:"ABSOLUTE" children.
    if ((node.children ?? []).some((c) => c.layoutPositioning === "ABSOLUTE"))
      cls.push("relative");
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
  if (fillW) cls.push(rowParent ? "grow" : "w-full");
  if (fillH) cls.push(rowParent ? "self-stretch" : "grow");

  // Figma never shrinks an item below its size unless it's set to "Fill" along
  // the layout axis; CSS flex items shrink by default (flex-shrink: 1). Without
  // shrink-0 the siblings squish unevenly as the container narrows and the
  // whole row/column drifts out of place — pin every non-Fill child.
  if (parentAuto && !absInAuto) {
    const mainAxisFill = rowParent ? fillW : fillH;
    if (!mainAxisFill) cls.push("shrink-0");
  }

  if (geo && !isText) {
    // A LINE (or a stroke-only divider) has a zero-height/width box; fall
    // back to the stroke weight so it doesn't collapse to h-[0px].
    const w = geo.width || node.strokeWeight || 1;
    const h = geo.height || node.strokeWeight || 1;
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

  // ---- Ellipse → circle (before asset export so a photo-in-circle <img>
  // keeps the clipping class too) ----
  if (node.type === "ELLIPSE" && !isArcEllipse(node)) cls.push("rounded-full");

  // ---- Asset export (icons → SVG, image fills → PNG) ----
  // Detect before background/children so icons don't become empty boxes.
  const icon = !isText && isIconNode(node);
  const imageLeaf = !isText && !icon && hasImageFill(node) && !node.children?.length;
  if (icon || imageLeaf) {
    el.tag = "img";
    const kind: "svg" | "png" = icon ? "svg" : "png";
    el.asset = { id: node.id, kind };
    if (kind === "svg") cls.push("object-contain");
    // Respect the fill's scaleMode: FIT keeps the whole image (contain),
    // FILL/CROP fill the box (cover). Default to cover when unknown.
    else cls.push(imageScaleMode(node) === "FIT" ? "object-contain" : "object-cover");
    assets.push({ id: node.id, kind, className: cls.join(" ") });
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
    const img = fills.find((f) => f.visible !== false && f.type === "IMAGE");
    const solidPaint = firstSolidPaint(fills);
    if (grads.length) {
      // Angular/diamond gradients have no CSS equivalent — approximated as a
      // linear gradient, so flag it as lossy.
      for (const grad of grads)
        if (grad.type === "GRADIENT_ANGULAR" || grad.type === "GRADIENT_DIAMOND")
          warn(opts, node, `${grad.type} approximated as a linear gradient`);
      // Stack every gradient into one `background`. CSS paints the first layer
      // on top; Figma's fills[0] is the bottom layer — so reverse. A solid fill
      // beneath the gradients becomes the last (bottom) layer, expressed as a
      // flat gradient so it can share the shorthand.
      const layers = [...grads].reverse().map(gradientCss).filter(Boolean) as string[];
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
      assets.push({ id: node.id, kind: "png", className: "" });
    } else if (solidPaint) {
      cls.push(colorClass("bg", solidPaint.value, opts.tokens, solidPaint.variableName));
    }
  }

  // ---- Border radius ----
  if (node.cornerRadius)
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

  // ---- Strokes / border ----
  const strokePaint = firstSolidPaint(node.strokes);
  const stroke = strokePaint?.value ?? null;
  if (stroke) {
    const isw = node.individualStrokeWeights;
    // An OUTSIDE stroke sits beyond the box and must not consume layout space
    // like a CSS border (border-box) would — an outline matches Figma exactly.
    if (node.strokeAlign === "OUTSIDE" && node.strokeWeight) {
      const kind = node.strokeDashes?.length ? "dashed" : "solid";
      el.style["outline"] = `${r(node.strokeWeight)}px ${kind} ${stroke}`;
      el.style["outline-offset"] = "0px";
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

  // ---- Opacity ----
  if (node.opacity != null && node.opacity < 1) {
    cls.push(`opacity-[${+node.opacity.toFixed(2)}]`);
  }

  // ---- Clip ----
  if (node.clipsContent) cls.push("overflow-hidden");

  // ---- Shadows (all drop/inner shadows, comma-joined like CSS) ----
  const shadows = (node.effects ?? []).filter(
    (e) =>
      e.visible !== false &&
      (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") &&
      e.offset &&
      e.color,
  );
  if (shadows.length) {
    const parts = shadows.map((s) => {
      const inset = s.type === "INNER_SHADOW" ? "inset_" : "";
      return `${inset}${r(s.offset!.x)}px_${r(s.offset!.y)}px_${r(s.radius ?? 0)}px_${r(s.spread ?? 0)}px_${colorToHex(s.color!).replace(/\s/g, "")}`;
    });
    cls.push(`shadow-[${parts.join(",")}]`);
  }

  // ---- Layer / background blur ----
  const layerBlur = (node.effects ?? []).find(
    (e) => e.visible !== false && e.type === "LAYER_BLUR" && (e.radius ?? 0) > 0,
  );
  const bgBlur = (node.effects ?? []).find(
    (e) => e.visible !== false && e.type === "BACKGROUND_BLUR" && (e.radius ?? 0) > 0,
  );
  if (layerBlur) cls.push(`blur-[${r(layerBlur.radius ?? 0)}px]`);
  if (bgBlur) cls.push(`backdrop-blur-[${r(bgBlur.radius ?? 0)}px]`);

  // ---- Rotation ----
  if (node.rotation && Math.abs(node.rotation) > 0.5) {
    cls.push(`rotate-[${+node.rotation.toFixed(1)}deg]`);
  }

  // ---- Blend mode (multiply / screen / overlay …) ----
  const blend = blendClass(node.blendMode);
  if (blend) cls.push(blend);

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
    // Fixed-width text (Figma autoResize HEIGHT/NONE) wraps at its box width;
    // without a width the copy renders on one line and overflows the layout.
    // Content-hugging text (WIDTH_AND_HEIGHT) is left width-less.
    const fixedWidthText =
      node.textAutoResize === "NONE" || node.textAutoResize === "HEIGHT";
    if (fixedWidthText && geo && !fillW && !constraintNoW)
      cls.push(`w-[${r(geo.width)}px]`);
    // Content-hugging text (autoResize WIDTH_AND_HEIGHT) sizes to its content and
    // never wraps in Figma. Without a width the browser wraps it to whatever room
    // is left — which is tiny when the node is centered (left-1/2 -translate-x-1/2)
    // or otherwise pinned mid-parent. whitespace-nowrap reproduces the hug.
    else if (node.textAutoResize === "WIDTH_AND_HEIGHT")
      cls.push("whitespace-nowrap");
    // Bound to a component TEXT property → render `{propName}` in the JSX.
    if (node.textProp) {
      const pn = propIdent(node.textProp);
      if (opts.propNames?.has(pn)) el.textProp = pn;
    }
    const colorPaint = firstSolidPaint(node.fills);
    if (colorPaint)
      cls.push(colorClass("text", colorPaint.value, opts.tokens, colorPaint.variableName));
  }

  // ---- Children ----
  if (!isText && node.children) {
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

  return el;
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
    JSON.stringify(el.attrs ?? {}) +
    (el.asset ? "#A" : "") +
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

/** True when every child is a plain-text leaf run (a styled <span>/<a> segment). */
function isInlineTextRuns(el: IRElement): boolean {
  return (
    el.children.length > 0 &&
    el.children.every(
      (c) => (c.tag === "span" || c.tag === "a") && c.text != null && !c.children.length,
    )
  );
}

function serializeInline(el: IRElement): string {
  const className = el.classes.length ? ` className="${el.classes.join(" ")}"` : "";
  const style = styleToJsx(el.style);
  const attrs = attrsStr(el.attrs);
  return `<${el.tag}${className}${style}${attrs}>${escapeJsxText(el.text ?? "")}</${el.tag}>`;
}

function serializeInlineHtml(el: IRElement): string {
  const className = el.classes.length ? ` class="${el.classes.join(" ")}"` : "";
  const style = styleToHtml(el.style);
  const attrs = attrsStr(el.attrs);
  return `<${el.tag}${className}${style}${attrs}>${escapeHtml(el.text ?? "")}</${el.tag}>`;
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
