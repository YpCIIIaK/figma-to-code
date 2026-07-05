// Minimal subset of the Figma REST API node shapes we actually use.
// Full spec: https://www.figma.com/developers/api#node-types

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigmaPaint {
  type: "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "IMAGE" | string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  gradientStops?: { position: number; color: FigmaColor }[];
  gradientHandlePositions?: { x: number; y: number }[];
  /** Angle (deg) precomputed from gradientHandlePositions by the plugin. */
  gradientAngle?: number;
  imageRef?: string;
  scaleMode?: string;
  /** Design-system token name when this paint is bound to a Figma variable. */
  variableName?: string;
}

/** A resolved Figma variable: its design-system name and current value. */
export interface VarToken {
  name: string;
  kind: "color" | "space" | "radius" | "size";
  /** CSS-ready value: hex/rgba for colors, "16px" for scales. */
  value: string;
}

export type Constraint = "MIN" | "MAX" | "CENTER" | "STRETCH" | "SCALE";

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaTypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  letterSpacing?: number;
  textAlignHorizontal?: "LEFT" | "RIGHT" | "CENTER" | "JUSTIFIED";
  textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
  textCase?: string;
  textDecoration?: string;
  italic?: boolean;
  /** Token name when the font size is bound to a Figma variable. */
  fontSizeVar?: string;
}

export type LayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";
export type AxisAlign = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" | "BASELINE";

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];

  absoluteBoundingBox?: FigmaRect;
  size?: { x: number; y: number };

  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  /** Per-side widths when the stroke weight is not uniform. */
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  /** Dash pattern; non-empty means a dashed stroke. */
  strokeDashes?: number[];

  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  /** How the stroke sits relative to the geometry edge. */
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";

  /** Resize behaviour of a free-form child relative to its parent frame. */
  constraints?: { horizontal?: Constraint; vertical?: Constraint };

  // Variable (design-token) bindings, resolved to token names by the plugin.
  itemSpacingVar?: string;
  paddingLeftVar?: string;
  paddingRightVar?: string;
  paddingTopVar?: string;
  paddingBottomVar?: string;
  cornerRadiusVar?: string;

  // Component provenance (INSTANCE / COMPONENT), for naming & componentization.
  componentName?: string;
  variantProperties?: Record<string, string>;
  /** Component property definitions (from an instance) → generated props. */
  componentProperties?: Record<string, { type: string; value: string | boolean }>;
  /** Prop name a TEXT node's characters are bound to (componentPropertyReference). */
  textProp?: string;
  /** Prop name controlling this node's visibility (BOOLEAN component property). */
  visibleProp?: string;
  /** Prop name this instance is swapped by (INSTANCE_SWAP) → a ReactNode slot. */
  swapProp?: string;
  /** Designer explicitly marked this node "Export as SVG" → treat as one icon. */
  svgExport?: boolean;

  // Prototype interactions (plugin reads node.reactions).
  /** Destination URL of an OPEN_URL click reaction → real <a href>. */
  href?: string;
  /** Has a navigation/click reaction with no URL → real <button>. */
  clickable?: boolean;

  // Auto-layout min/max sizing (Figma "min width" / "max width" etc.).
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // Text truncation
  /** "ENDING" when the text is set to truncate with an ellipsis. */
  textTruncate?: string;
  /** Max visible lines before truncation (Figma "max lines"). */
  maxLines?: number;
  /** Partial ellipse (arc/donut) — present only when not a full circle. */
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };

  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  /** Clockwise rotation in degrees (plugin precomputes from the transform). */
  rotation?: number;

  effects?: {
    type: string;
    visible?: boolean;
    color?: FigmaColor;
    offset?: { x: number; y: number };
    radius?: number;
    spread?: number;
  }[];

  // Auto-layout
  layoutMode?: LayoutMode;
  primaryAxisAlignItems?: AxisAlign;
  counterAxisAlignItems?: AxisAlign;
  primaryAxisSizingMode?: "FIXED" | "AUTO";
  counterAxisSizingMode?: "FIXED" | "AUTO";
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  layoutWrap?: "NO_WRAP" | "WRAP";

  /**
   * Figma's inferred auto-layout for a frame the designer left free-form
   * (node.inferredAutoLayout). Present only when the children genuinely flow as
   * a clean row/column; lets us emit flex instead of absolute soup.
   */
  inferredLayout?: {
    layoutMode: "HORIZONTAL" | "VERTICAL";
    itemSpacing?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    primaryAxisAlignItems?: AxisAlign;
    counterAxisAlignItems?: AxisAlign;
  };

  // Auto-layout child properties
  /** "ABSOLUTE" — the child is taken out of the auto-layout flow. */
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  /** "STRETCH" — fill the parent's counter axis. */
  layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  /** > 0 — grow along the parent's primary axis. */
  layoutGrow?: number;
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";

  // Text
  characters?: string;
  /**
   * Text box resize behaviour. HEIGHT / NONE mean a fixed width (the copy wraps
   * at that width); WIDTH_AND_HEIGHT hugs the content (no width emitted).
   */
  textAutoResize?: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE";
  style?: FigmaTypeStyle;
  /** Per-range runs when the text has mixed styling (bold word, link, color). */
  styledSegments?: TextSegment[];
}

/** A run of characters that share one style (from Figma's getStyledTextSegments). */
export interface TextSegment {
  characters: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  italic?: boolean;
  textDecoration?: string;
  color?: string;
  /** Destination URL when this run is a hyperlink → wrap the run in <a href>. */
  href?: string;
}

export interface FigmaFileResponse {
  name: string;
  lastModified: string;
  document: FigmaNode;
}

export interface FigmaNodesResponse {
  name: string;
  nodes: Record<string, { document: FigmaNode } | undefined>;
}

export interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

/** A trimmed node tree we send to the client for the layer panel. */
export interface TreeNode {
  id: string;
  name: string;
  type: string;
  children?: TreeNode[];
}
