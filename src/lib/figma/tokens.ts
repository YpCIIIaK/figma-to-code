import type { FigmaNode, FigmaColor, FigmaPaint } from "./types";

// ---------------------------------------------------------------------------
// Design-token extraction: walk a Figma subtree and collect the colors,
// typography, spacing, radii and shadows it actually uses, then serialize them
// to CSS variables, a Tailwind v4 `@theme` block, or a JSON token file.
// ---------------------------------------------------------------------------

export interface ColorToken {
  name: string;
  value: string; // hex or rgba()
  count: number;
}
export interface TypographyToken {
  name: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  count: number;
}
export interface ScaleToken {
  name: string;
  value: number; // px
  count: number;
}
export interface ShadowToken {
  name: string;
  value: string; // CSS box-shadow
  count: number;
}

export interface TokenSet {
  colors: ColorToken[];
  typography: TypographyToken[];
  spacing: ScaleToken[];
  radii: ScaleToken[];
  fontFamilies: { name: string; value: string; count: number }[];
  fontSizes: ScaleToken[];
  shadows: ShadowToken[];
}

const round = (n: number) => Math.round(n);

function colorToCss(c: FigmaColor): string {
  const to = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  if (c.a < 1) {
    return `rgba(${round(c.r * 255)}, ${round(c.g * 255)}, ${round(
      c.b * 255,
    )}, ${+c.a.toFixed(2)})`;
  }
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function solidsOf(paints?: FigmaPaint[]): FigmaColor[] {
  if (!paints) return [];
  const out: FigmaColor[] = [];
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === "SOLID" && p.color) {
      out.push({ ...p.color, a: (p.color.a ?? 1) * (p.opacity ?? 1) });
    }
  }
  return out;
}

// --- Human-ish color naming -------------------------------------------------
// Map a color to a base hue name + lightness bucket so tokens read nicely
// (e.g. --color-blue-700) instead of --color-1. Collisions get a numeric tail.
function baseColorName(c: FigmaColor): string {
  const r = c.r,
    g = c.g,
    b = c.b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const sat = max - min;

  // Achromatic
  if (sat < 0.08) {
    if (l > 0.96) return "white";
    if (l < 0.06) return "black";
    return l > 0.6 ? "gray-light" : l > 0.35 ? "gray" : "gray-dark";
  }

  // Hue in degrees
  let h = 0;
  if (max === r) h = ((g - b) / sat) % 6;
  else if (max === g) h = (b - r) / sat + 2;
  else h = (r - g) / sat + 4;
  h = (h * 60 + 360) % 360;

  let hue: string;
  if (h < 15 || h >= 345) hue = "red";
  else if (h < 45) hue = "orange";
  else if (h < 70) hue = "yellow";
  else if (h < 165) hue = "green";
  else if (h < 200) hue = "teal";
  else if (h < 255) hue = "blue";
  else if (h < 290) hue = "purple";
  else if (h < 345) hue = "pink";
  else hue = "color";

  const tone = l > 0.7 ? "300" : l > 0.45 ? "500" : "700";
  return `${hue}-${tone}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Walk the subtree and tally every token-worthy value. */
export function extractTokens(root: FigmaNode): TokenSet {
  const colors = new Map<string, ColorToken>();
  const typo = new Map<string, TypographyToken>();
  const spacing = new Map<number, ScaleToken>();
  const radii = new Map<number, ScaleToken>();
  const families = new Map<string, { name: string; value: string; count: number }>();
  const sizes = new Map<number, ScaleToken>();
  const shadows = new Map<string, ShadowToken>();

  const addColor = (c: FigmaColor) => {
    const value = colorToCss(c);
    const cur = colors.get(value);
    if (cur) cur.count++;
    else colors.set(value, { name: "", value, count: 1 });
  };
  const addScale = (m: Map<number, ScaleToken>, v?: number) => {
    if (!v || v <= 0) return;
    const k = round(v);
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { name: "", value: k, count: 1 });
  };

  const walk = (n: FigmaNode) => {
    if (n.visible === false) return;

    solidsOf(n.fills).forEach(addColor);
    solidsOf(n.strokes).forEach(addColor);

    addScale(spacing, n.itemSpacing);
    addScale(spacing, n.paddingLeft);
    addScale(spacing, n.paddingRight);
    addScale(spacing, n.paddingTop);
    addScale(spacing, n.paddingBottom);
    addScale(radii, n.cornerRadius);

    if (n.type === "TEXT" && n.style) {
      const s = n.style;
      addScale(sizes, s.fontSize);
      if (s.fontFamily) {
        const key = s.fontFamily;
        const cur = families.get(key);
        if (cur) cur.count++;
        else families.set(key, { name: slug(key), value: key, count: 1 });
      }
      const key = [
        s.fontFamily ?? "",
        s.fontSize ?? "",
        s.fontWeight ?? "",
        round(s.lineHeightPx ?? 0),
        s.letterSpacing ?? "",
      ].join("|");
      const cur = typo.get(key);
      if (cur) cur.count++;
      else
        typo.set(key, {
          name: "",
          fontFamily: s.fontFamily,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          lineHeightPx: s.lineHeightPx,
          letterSpacing: s.letterSpacing,
          count: 1,
        });
    }

    for (const e of n.effects ?? []) {
      if (e.visible === false) continue;
      if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
      if (!e.offset || !e.color) continue;
      const inset = e.type === "INNER_SHADOW" ? "inset " : "";
      const value = `${inset}${round(e.offset.x)}px ${round(e.offset.y)}px ${round(
        e.radius ?? 0,
      )}px ${round(e.spread ?? 0)}px ${colorToCss(e.color)}`;
      const cur = shadows.get(value);
      if (cur) cur.count++;
      else shadows.set(value, { name: "", value, count: 1 });
    }

    for (const child of n.children ?? []) walk(child);
  };

  walk(root);

  // --- Name colors (by hue) with collision suffixes -----------------------
  const colorList = [...colors.values()].sort((a, b) => b.count - a.count);
  const usedColorNames = new Map<string, number>();
  for (const t of colorList) {
    const m = /^#([0-9a-f]{6})$/i.exec(t.value);
    let base: string;
    if (m) {
      const hex = m[1];
      base = baseColorName({
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: 1,
      });
    } else {
      base = "color"; // rgba()
    }
    const seen = usedColorNames.get(base) ?? 0;
    usedColorNames.set(base, seen + 1);
    t.name = seen === 0 ? base : `${base}-${seen + 1}`;
  }

  // --- Name spacing / radii / font-sizes by their px value ----------------
  const nameByValue = (list: ScaleToken[], prefix: string) =>
    list
      .sort((a, b) => a.value - b.value)
      .forEach((t) => (t.name = `${prefix}-${t.value}`));
  const spacingList = [...spacing.values()];
  const radiiList = [...radii.values()];
  const sizeList = [...sizes.values()];
  nameByValue(spacingList, "spacing");
  nameByValue(radiiList, "radius");
  nameByValue(sizeList, "text");

  // --- Name typography by size (desc) -------------------------------------
  const typoList = [...typo.values()].sort(
    (a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0),
  );
  typoList.forEach((t, i) => (t.name = `type-${i + 1}`));

  // --- Name shadows -------------------------------------------------------
  const shadowList = [...shadows.values()].sort((a, b) => b.count - a.count);
  shadowList.forEach((t, i) => (t.name = shadowList.length > 1 ? `shadow-${i + 1}` : "shadow"));

  return {
    colors: colorList,
    typography: typoList,
    spacing: spacingList,
    radii: radiiList,
    fontFamilies: [...families.values()].sort((a, b) => b.count - a.count),
    fontSizes: sizeList,
    shadows: shadowList,
  };
}

export function isEmptyTokens(t: TokenSet): boolean {
  return (
    !t.colors.length &&
    !t.typography.length &&
    !t.spacing.length &&
    !t.radii.length &&
    !t.fontFamilies.length &&
    !t.shadows.length
  );
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export type TokenFormat = "css" | "tailwind" | "json";

export function serializeTokens(t: TokenSet, format: TokenFormat): string {
  if (format === "json") return tokensToJson(t);
  if (format === "tailwind") return tokensToTailwind(t);
  return tokensToCss(t);
}

function section(title: string, lines: string[]): string {
  if (!lines.length) return "";
  return `  /* ${title} */\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
}

function tokensToCss(t: TokenSet): string {
  const blocks: string[] = [];
  blocks.push(
    section(
      "Colors",
      t.colors.map((c) => `--color-${c.name}: ${c.value};`),
    ),
  );
  blocks.push(
    section(
      "Font families",
      t.fontFamilies.map((f) => `--font-${f.name}: "${f.value}", sans-serif;`),
    ),
  );
  blocks.push(
    section(
      "Font sizes",
      t.fontSizes.map((s) => `--text-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Spacing",
      t.spacing.map((s) => `--spacing-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Radius",
      t.radii.map((s) => `--radius-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Shadows",
      t.shadows.map((s) => `--${s.name}: ${s.value};`),
    ),
  );
  const body = blocks.filter(Boolean).join("\n");
  return `:root {\n${body}}\n`;
}

function tokensToTailwind(t: TokenSet): string {
  // Tailwind v4: tokens declared inside @theme become utilities
  // (e.g. --color-blue-500 → bg-blue-500, text-blue-500).
  const blocks: string[] = [];
  blocks.push(
    section(
      "Colors → bg-*/text-*/border-*",
      t.colors.map((c) => `--color-${c.name}: ${c.value};`),
    ),
  );
  blocks.push(
    section(
      "Font families → font-*",
      t.fontFamilies.map((f) => `--font-${f.name}: "${f.value}", sans-serif;`),
    ),
  );
  blocks.push(
    section(
      "Font sizes → text-*",
      t.fontSizes.map((s) => `--text-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Spacing → p-*/m-*/gap-*",
      t.spacing.map((s) => `--spacing-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Radius → rounded-*",
      t.radii.map((s) => `--radius-${s.value}: ${s.value}px;`),
    ),
  );
  blocks.push(
    section(
      "Shadows → shadow-*",
      t.shadows.map((s) => `--${s.name}: ${s.value};`),
    ),
  );
  const body = blocks.filter(Boolean).join("\n");
  return `@theme {\n${body}}\n`;
}

function tokensToJson(t: TokenSet): string {
  const obj = {
    color: Object.fromEntries(t.colors.map((c) => [c.name, c.value])),
    fontFamily: Object.fromEntries(
      t.fontFamilies.map((f) => [f.name, f.value]),
    ),
    fontSize: Object.fromEntries(t.fontSizes.map((s) => [String(s.value), `${s.value}px`])),
    spacing: Object.fromEntries(t.spacing.map((s) => [String(s.value), `${s.value}px`])),
    radius: Object.fromEntries(t.radii.map((s) => [String(s.value), `${s.value}px`])),
    typography: Object.fromEntries(
      t.typography.map((tp) => [
        tp.name,
        {
          fontFamily: tp.fontFamily,
          fontSize: tp.fontSize ? `${tp.fontSize}px` : undefined,
          fontWeight: tp.fontWeight,
          lineHeight: tp.lineHeightPx ? `${round(tp.lineHeightPx)}px` : undefined,
          letterSpacing: tp.letterSpacing
            ? `${+tp.letterSpacing.toFixed(2)}px`
            : undefined,
        },
      ]),
    ),
    shadow: Object.fromEntries(t.shadows.map((s) => [s.name, s.value])),
  };
  return JSON.stringify(obj, null, 2) + "\n";
}
