// Figma Copy companion — main thread (no DOM here).
// Serializes the current selection into the same shape the app's REST client
// produces (see src/lib/figma/types.ts), and exports each icon/image locally
// via exportAsync — so the app never touches Figma's rate-limited render API.

figma.showUI(__html__, { width: 320, height: 320 });

// Restore the saved app address and push a live selection count to the UI.
figma.clientStorage.getAsync("endpoint").then((ep) => {
  if (ep) figma.ui.postMessage({ type: "endpoint", endpoint: ep });
});

function postSelectionCount() {
  figma.ui.postMessage({
    type: "selection",
    count: figma.currentPage.selection.length,
  });
}
figma.on("selectionchange", postSelectionCount);
postSelectionCount();

const VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON", "LINE"];
const CONTAINER_TYPES = ["FRAME", "GROUP", "INSTANCE", "COMPONENT"];

const isNum = (v) => typeof v === "number";
const MIXED = figma.mixed;

function subtreeHasText(n) {
  if (n.type === "TEXT") return true;
  return (n.children || []).some(subtreeHasText);
}
function subtreeHasVector(n) {
  if (VECTOR_TYPES.indexOf(n.type) !== -1) return true;
  return (n.children || []).some(subtreeHasVector);
}
function isArcEllipse(n) {
  if (n.type !== "ELLIPSE" || !n.arcData) return false;
  const a = n.arcData;
  const full = Math.abs(a.endingAngle - a.startingAngle) >= Math.PI * 2 - 0.001;
  return !full || (a.innerRadius && a.innerRadius > 0);
}
function isIconNode(n) {
  if (VECTOR_TYPES.indexOf(n.type) !== -1) return true;
  if (isArcEllipse(n)) return true;
  if (CONTAINER_TYPES.indexOf(n.type) !== -1 && n.children && n.children.length) {
    // A photo (image fill) is never an icon — flattening it to SVG embeds the
    // raster and bloats the code; let it become a background image instead.
    if (hasImageFill(n)) return false;
    if (subtreeHasText(n)) return false;
    if (!subtreeHasVector(n)) return false;
    // Vectors nested in their own frames/groups are separate icons (e.g. a row
    // of social icons) — keep them split instead of merging into one big SVG.
    var nested = n.children.some(function (c) {
      return CONTAINER_TYPES.indexOf(c.type) !== -1;
    });
    if (nested) return false;
    return true;
  }
  return false;
}
function hasImageFill(n) {
  return (
    Array.isArray(n.fills) &&
    n.fills.some((f) => f.visible !== false && f.type === "IMAGE")
  );
}

// A prototype reaction (OPEN_URL / navigate) is a far more reliable signal of a
// real link/button than guessing from the layer name — surface it to the app.
function tagInteraction(node, out) {
  const rs = node.reactions;
  if (!Array.isArray(rs) || !rs.length) return;
  // OPEN_URL anywhere → a real <a href>.
  for (const rx of rs) {
    const acts = rx.actions || (rx.action ? [rx.action] : []);
    for (const a of acts) {
      if (a && a.type === "URL" && a.url) {
        out.href = a.url;
        return;
      }
    }
  }
  // Otherwise a click/press reaction (navigate to a frame) → a real <button>.
  for (const rx of rs) {
    const t = rx.trigger && rx.trigger.type;
    if (t === "ON_CLICK" || t === "ON_PRESS") {
      out.clickable = true;
      return;
    }
  }
}

// ---- Figma variables → design-system tokens -------------------------------
// A node property bound to a variable (color/primary/500, spacing/md) is the
// designer's real token — infinitely better than guessing a name from the hex.

const rgbHex = (c) => {
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  if (c.a != null && c.a < 1)
    return (
      "rgba(" +
      Math.round(c.r * 255) + "," +
      Math.round(c.g * 255) + "," +
      Math.round(c.b * 255) + "," +
      +Number(c.a).toFixed(2) + ")"
    );
  return "#" + to(c.r) + to(c.g) + to(c.b);
};

/** "color/primary/500" → "primary-500"; drop a leading category segment. */
function sanitizeVarName(raw) {
  const drop = {
    color: 1, colors: 1, fill: 1, fills: 1, text: 1, spacing: 1, space: 1,
    size: 1, sizing: 1, radius: 1, radii: 1, corner: 1, rounded: 1, gap: 1,
    padding: 1,
  };
  const parts = raw.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && drop[parts[0].toLowerCase()]) parts.shift();
  const name = parts
    .join("-")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return name || "token";
}

/** Resolve a variable id (following alias chains) to { name, color, num }. */
async function resolveVar(id, cache) {
  if (cache.has(id)) return cache.get(id);
  let v = null;
  try {
    v = await figma.variables.getVariableByIdAsync(id);
  } catch (e) {
    /* variable not accessible */
  }
  if (!v) {
    cache.set(id, null);
    return null;
  }
  const name = sanitizeVarName(v.name);
  let raw = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  let guard = 0;
  while (raw && raw.type === "VARIABLE_ALIAS" && guard++ < 10) {
    let inner = null;
    try {
      inner = await figma.variables.getVariableByIdAsync(raw.id);
    } catch (e) {
      break;
    }
    if (!inner) break;
    raw = inner.valuesByMode[Object.keys(inner.valuesByMode)[0]];
  }
  const out = { name, color: null, num: null };
  if (raw && typeof raw === "object" && "r" in raw) out.color = rgbHex(raw);
  else if (typeof raw === "number") out.num = raw;
  cache.set(id, out);
  return out;
}

function boundIds(bv, acc) {
  if (!bv) return;
  for (const k in bv) {
    const v = bv[k];
    if (Array.isArray(v)) v.forEach((a) => a && a.id && acc.add(a.id));
    else if (v && v.id) acc.add(v.id);
  }
}

/**
 * Two async pre-passes over the live selection: resolve every bound variable,
 * and fetch each instance's main-component name (both need async APIs, so we
 * can't do them inside the synchronous serialize()).
 */
async function buildContext(topNodes) {
  const cache = new Map();
  const comp = new Map();
  const ids = new Set();
  async function walk(n) {
    boundIds(n.boundVariables, ids);
    if (n.type === "INSTANCE" && typeof n.getMainComponentAsync === "function") {
      try {
        const mc = await n.getMainComponentAsync();
        if (mc) {
          const setName =
            mc.parent && mc.parent.type === "COMPONENT_SET" ? mc.parent.name : mc.name;
          comp.set(n.id, setName);
        }
      } catch (e) {
        /* ignore */
      }
    }
    for (const c of n.children || []) await walk(c);
  }
  for (const t of topNodes) await walk(t);
  for (const id of ids) await resolveVar(id, cache);
  return { cache, comp, tokens: new Map() };
}

/** Look up a bound variable's token name for a single-value property. */
function varNameOf(node, prop, ctx, kind) {
  const bv = node.boundVariables && node.boundVariables[prop];
  if (!bv || !bv.id) return undefined;
  const r = ctx.cache.get(bv.id);
  if (!r || r.num == null) return undefined;
  ctx.tokens.set(kind + ":" + r.name, {
    name: r.name,
    kind: kind,
    value: Math.round(r.num) + "px",
  });
  return r.name;
}

/** Attach the token name (and record the token) for a bound color paint. */
function colorVarName(id, ctx) {
  const r = ctx.cache.get(id);
  if (!r || !r.color) return undefined;
  ctx.tokens.set("color:" + r.name, { name: r.name, kind: "color", value: r.color });
  return r.name;
}

/**
 * Figma stores a gradient as a transform matrix; derive the CSS angle from
 * where the gradient's start/end handles land so the direction matches Figma.
 */
function gradientAngle(p) {
  const h = p.gradientHandlePositions;
  if (!h || h.length < 2) return undefined;
  const dx = h[1].x - h[0].x;
  const dy = h[1].y - h[0].y;
  // CSS 0deg points up; Figma's y grows downward — convert accordingly.
  let deg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg);
}

function paintToRest(p) {
  const out = { type: p.type, visible: p.visible !== false, opacity: p.opacity };
  if (p.type === "SOLID" && p.color) {
    out.color = { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 };
  } else if (p.type === "IMAGE") {
    // scaleMode (FILL/FIT/TILE/CROP) decides object-fit / background-size.
    if (p.scaleMode) out.scaleMode = p.scaleMode;
  } else if (typeof p.type === "string" && p.type.indexOf("GRADIENT") === 0) {
    out.gradientStops = (p.gradientStops || []).map((s) => ({
      position: s.position,
      color: s.color,
    }));
    if (p.gradientHandlePositions) {
      out.gradientHandlePositions = p.gradientHandlePositions.map((g) => ({ x: g.x, y: g.y }));
      const a = gradientAngle(p);
      if (a != null) out.gradientAngle = a;
    }
  }
  return out;
}

/** Solid fill of a single text segment → "#rrggbb" for the converter. */
function segColor(fills) {
  if (!Array.isArray(fills)) return undefined;
  for (const f of fills) {
    if (f.visible !== false && f.type === "SOLID" && f.color) {
      const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
      return "#" + to(f.color.r) + to(f.color.g) + to(f.color.b);
    }
  }
  return undefined;
}

/** Extract per-range text runs so mixed styling (bold/link/colour) survives. */
function styledSegments(node) {
  let segs;
  try {
    segs = node.getStyledTextSegments([
      "fontSize",
      "fontName",
      "fontWeight",
      "fills",
      "textDecoration",
      "hyperlink",
    ]);
  } catch (e) {
    return undefined;
  }
  if (!segs || segs.length < 2) return undefined;
  return segs.map((s) => {
    const out = { characters: s.characters };
    if (isNum(s.fontSize)) out.fontSize = s.fontSize;
    if (isNum(s.fontWeight)) out.fontWeight = s.fontWeight;
    if (s.fontName && s.fontName !== MIXED) {
      out.fontFamily = s.fontName.family;
      if (/italic/i.test(s.fontName.style)) out.italic = true;
    }
    if (s.textDecoration && s.textDecoration !== MIXED) out.textDecoration = s.textDecoration;
    const c = segColor(s.fills);
    if (c) out.color = c;
    // A hyperlinked run → a real inline <a href> in the generated code.
    if (s.hyperlink && s.hyperlink.type === "URL" && s.hyperlink.value)
      out.href = s.hyperlink.value;
    return out;
  });
}

function textStyle(node) {
  const s = {};
  if (isNum(node.fontSize)) s.fontSize = node.fontSize;
  if (node.fontName && node.fontName !== MIXED) {
    s.fontFamily = node.fontName.family;
    if (/italic/i.test(node.fontName.style)) s.italic = true;
  }
  if (isNum(node.fontWeight)) s.fontWeight = node.fontWeight;
  if (node.lineHeight && node.lineHeight !== MIXED) {
    const lh = node.lineHeight;
    if (lh.unit === "PIXELS") s.lineHeightPx = lh.value;
    else if (lh.unit === "PERCENT" && isNum(node.fontSize))
      s.lineHeightPx = (node.fontSize * lh.value) / 100;
  }
  if (node.letterSpacing && node.letterSpacing !== MIXED) {
    const ls = node.letterSpacing;
    if (ls.unit === "PIXELS") s.letterSpacing = ls.value;
    else if (ls.unit === "PERCENT" && isNum(node.fontSize))
      s.letterSpacing = (node.fontSize * ls.value) / 100;
  }
  if (node.textAlignHorizontal) s.textAlignHorizontal = node.textAlignHorizontal;
  if (node.textAlignVertical && node.textAlignVertical !== "TOP")
    s.textAlignVertical = node.textAlignVertical;
  if (node.textCase && node.textCase !== MIXED) s.textCase = node.textCase;
  if (node.textDecoration && node.textDecoration !== MIXED)
    s.textDecoration = node.textDecoration;
  return s;
}

/** Attach bound-variable token names to an array of serialized paints. */
function tagPaintVars(paints, aliases, ctx) {
  if (!Array.isArray(paints) || !Array.isArray(aliases)) return;
  for (let i = 0; i < paints.length; i++) {
    const a = aliases[i];
    if (a && a.id) {
      const name = colorVarName(a.id, ctx);
      if (name) paints[i].variableName = name;
    }
  }
}

/** Convert a live Figma node into the REST-shaped JSON the converter expects. */
function serialize(node, ctx) {
  const out = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) out.visible = false;
  tagInteraction(node, out);

  const bb = node.absoluteBoundingBox;
  if (bb) out.absoluteBoundingBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  const bvars = node.boundVariables || {};

  let fills = node.fills;
  // Text with per-range styling reports fills as figma.mixed — fall back to
  // the first character's fill so the converter still gets a text color.
  if (fills === MIXED && node.type === "TEXT") {
    try {
      fills = node.getRangeFills(0, 1);
    } catch (e) {
      fills = null;
    }
  }
  if (Array.isArray(fills)) {
    out.fills = fills.map(paintToRest);
    tagPaintVars(out.fills, bvars.fills, ctx);
  }
  if (Array.isArray(node.strokes) && node.strokes.length) {
    out.strokes = node.strokes.map(paintToRest);
    tagPaintVars(out.strokes, bvars.strokes, ctx);
  }
  if (isNum(node.strokeWeight)) out.strokeWeight = node.strokeWeight;
  else if (
    // figma.mixed weight (differs per side) → per-side, same shape as REST.
    [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight].some(isNum)
  ) {
    out.individualStrokeWeights = {
      top: node.strokeTopWeight || 0,
      right: node.strokeRightWeight || 0,
      bottom: node.strokeBottomWeight || 0,
      left: node.strokeLeftWeight || 0,
    };
  }
  if (Array.isArray(node.dashPattern) && node.dashPattern.length)
    out.strokeDashes = node.dashPattern.slice();

  // Partial ellipse (arc / donut / crescent) can't be expressed in CSS —
  // flag it so the converter exports the node as SVG instead of a circle div.
  if (node.type === "ELLIPSE" && node.arcData) {
    const a = node.arcData;
    const full = Math.abs(a.endingAngle - a.startingAngle) >= Math.PI * 2 - 0.001;
    if (!full || (a.innerRadius && a.innerRadius > 0)) {
      out.arcData = {
        startingAngle: a.startingAngle,
        endingAngle: a.endingAngle,
        innerRadius: a.innerRadius || 0,
      };
    }
  }

  if (isNum(node.cornerRadius)) out.cornerRadius = node.cornerRadius;
  else if (isNum(node.topLeftRadius))
    out.rectangleCornerRadii = [
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius,
    ];
  const cornerVar =
    varNameOf(node, "cornerRadius", ctx, "radius") ||
    varNameOf(node, "topLeftRadius", ctx, "radius");
  if (cornerVar) out.cornerRadiusVar = cornerVar;

  // Stroke alignment governs whether the border adds to the element's size.
  if (node.strokeAlign) out.strokeAlign = node.strokeAlign;

  // Resize constraints — the key to emitting responsive (stretch/pin) layout.
  if (node.constraints)
    out.constraints = {
      horizontal: node.constraints.horizontal,
      vertical: node.constraints.vertical,
    };

  // Component provenance: main-component name + variant props.
  if (node.type === "INSTANCE") {
    const cn = ctx.comp.get(node.id);
    if (cn) out.componentName = cn;
    if (node.variantProperties) {
      const vp = {};
      for (const k in node.variantProperties) vp[k] = String(node.variantProperties[k]);
      if (Object.keys(vp).length) out.variantProperties = vp;
    }
    // Component property definitions (TEXT/BOOLEAN/…) → generated React props.
    if (node.componentProperties) {
      const cp = {};
      for (const k in node.componentProperties) {
        const d = node.componentProperties[k];
        if (!d) continue;
        cp[k] = {
          type: d.type,
          value: typeof d.value === "boolean" ? d.value : String(d.value),
        };
      }
      if (Object.keys(cp).length) out.componentProperties = cp;
    }
  }

  if (isNum(node.opacity) && node.opacity < 1) out.opacity = node.opacity;
  if (node.clipsContent) out.clipsContent = true;

  // Rotation: Figma reports it counter-clockwise; CSS rotate() is clockwise.
  if (isNum(node.rotation) && Math.abs(node.rotation) > 0.5) {
    out.rotation = -node.rotation;
  }

  // Blend mode → mix-blend-* (NORMAL / PASS_THROUGH map to nothing).
  if (node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH")
    out.blendMode = node.blendMode;

  // Component property references (works on any node inside an instance):
  // a BOOLEAN toggles visibility → conditional render; INSTANCE_SWAP → a slot.
  const cref = node.componentPropertyReferences;
  if (cref) {
    if (cref.visible) out.visibleProp = cref.visible;
    if (cref.mainComponent) out.swapProp = cref.mainComponent;
  }

  // Explicit "Export as SVG" mark → the converter flattens the node to one icon.
  if (Array.isArray(node.exportSettings) && node.exportSettings.some((s) => s.format === "SVG"))
    out.svgExport = true;

  if (Array.isArray(node.effects) && node.effects.length) {
    out.effects = node.effects.map((e) => ({
      type: e.type,
      visible: e.visible !== false,
      color: e.color,
      offset: e.offset,
      radius: e.radius,
      spread: e.spread,
    }));
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode;
    out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    out.counterAxisAlignItems = node.counterAxisAlignItems;
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
    if (isNum(node.itemSpacing)) out.itemSpacing = node.itemSpacing;
    out.paddingLeft = node.paddingLeft;
    out.paddingRight = node.paddingRight;
    out.paddingTop = node.paddingTop;
    out.paddingBottom = node.paddingBottom;
    if (node.layoutWrap) out.layoutWrap = node.layoutWrap;

    const isv = varNameOf(node, "itemSpacing", ctx, "space");
    if (isv) out.itemSpacingVar = isv;
    const plv = varNameOf(node, "paddingLeft", ctx, "space");
    if (plv) out.paddingLeftVar = plv;
    const prv = varNameOf(node, "paddingRight", ctx, "space");
    if (prv) out.paddingRightVar = prv;
    const ptv = varNameOf(node, "paddingTop", ctx, "space");
    if (ptv) out.paddingTopVar = ptv;
    const pbv = varNameOf(node, "paddingBottom", ctx, "space");
    if (pbv) out.paddingBottomVar = pbv;
  } else if (node.inferredAutoLayout) {
    // Free-form frame Figma believes flows as a clean row/column → send the
    // inferred layout so the app can (opt-in) emit flex instead of absolute.
    const il = node.inferredAutoLayout;
    if (il.layoutMode === "HORIZONTAL" || il.layoutMode === "VERTICAL") {
      out.inferredLayout = {
        layoutMode: il.layoutMode,
        itemSpacing: isNum(il.itemSpacing) ? il.itemSpacing : 0,
        paddingLeft: il.paddingLeft,
        paddingRight: il.paddingRight,
        paddingTop: il.paddingTop,
        paddingBottom: il.paddingBottom,
        primaryAxisAlignItems: il.primaryAxisAlignItems,
        counterAxisAlignItems: il.counterAxisAlignItems,
      };
    }
  }

  // Auto-layout child properties: absolute overlays and FILL/HUG sizing —
  // without these the converter hard-codes canvas px sizes and layout drifts.
  if (node.layoutPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";
  if (node.layoutAlign === "STRETCH") out.layoutAlign = "STRETCH";
  if (isNum(node.layoutGrow) && node.layoutGrow > 0) out.layoutGrow = node.layoutGrow;
  if (node.layoutSizingHorizontal) out.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if (node.layoutSizingVertical) out.layoutSizingVertical = node.layoutSizingVertical;

  // Min/max size constraints — let the app emit responsive max-w/min-w instead
  // of a single hard-locked px width.
  if (isNum(node.minWidth)) out.minWidth = node.minWidth;
  if (isNum(node.maxWidth)) out.maxWidth = node.maxWidth;
  if (isNum(node.minHeight)) out.minHeight = node.minHeight;
  if (isNum(node.maxHeight)) out.maxHeight = node.maxHeight;

  if (node.type === "TEXT") {
    out.characters = node.characters;
    out.style = textStyle(node);
    // Resize mode decides whether the text has a fixed width (wraps) or hugs.
    if (node.textAutoResize) out.textAutoResize = node.textAutoResize;
    const fsv = varNameOf(node, "fontSize", ctx, "size");
    if (fsv) out.style.fontSizeVar = fsv;
    const segs = styledSegments(node);
    if (segs) out.styledSegments = segs;
    // Truncation → truncate / line-clamp-N.
    if (node.textTruncate && node.textTruncate !== "DISABLED")
      out.textTruncate = node.textTruncate;
    if (isNum(node.maxLines)) out.maxLines = node.maxLines;
    // Text bound to a component TEXT property → render `{prop}` in the app.
    const ref = node.componentPropertyReferences;
    if (ref && ref.characters) out.textProp = ref.characters;
  }

  if ("children" in node && node.children && node.children.length) {
    out.children = node.children
      .filter((c) => c.visible !== false)
      .map((c) => serialize(c, ctx));
  }
  return out;
}

/** Walk the serialized tree and collect the ids to export (mirrors convert.ts). */
function collectAssets(n, acc) {
  if (isIconNode(n)) {
    acc.push({ id: n.id, kind: "svg" });
    return; // the whole icon subtree becomes one asset
  }
  if (hasImageFill(n)) {
    if (n.children && n.children.length) {
      // A container with a photo background: export the fill alone (children
      // are hidden during export) so it becomes a real background-image.
      acc.push({ id: n.id, kind: "bg" });
      for (const c of n.children || []) collectAssets(c, acc);
    } else {
      acc.push({ id: n.id, kind: "png" });
    }
    return;
  }
  for (const c of n.children || []) collectAssets(c, acc);
}

/**
 * 2x export, but capped at maxPx on the longest side — uncapped 2x PNGs of
 * wide sections (maps, hero photos) blow the app's 25 MB ingest limit (413).
 */
function pngConstraint(node, maxPx) {
  const w = node.width || 0;
  const h = node.height || 0;
  const side = Math.max(w, h);
  if (side * 2 <= maxPx || !side) return { type: "SCALE", value: 2 };
  return w >= h
    ? { type: "WIDTH", value: maxPx }
    : { type: "HEIGHT", value: maxPx };
}

async function run() {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "error", message: "Ничего не выбрано в Figma." });
    return;
  }

  figma.ui.postMessage({ type: "progress", message: "Читаю переменные и компоненты…" });
  const ctx = await buildContext(sel);

  // One node → send it; several → a synthetic group (app also supports this).
  let node;
  if (sel.length === 1) {
    node = serialize(sel[0], ctx);
  } else {
    let x = Infinity, y = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of sel) {
      const b = s.absoluteBoundingBox;
      if (!b) continue;
      x = Math.min(x, b.x); y = Math.min(y, b.y);
      x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
    }
    node = {
      id: "selection",
      name: "Selection",
      type: "GROUP",
      layoutMode: "NONE",
      absoluteBoundingBox: { x, y, width: x2 - x, height: y2 - y },
      children: sel.map((s) => serialize(s, ctx)),
    };
  }

  const assetRefs = [];
  collectAssets(node, assetRefs);

  const assets = [];
  let done = 0;
  for (const ref of assetRefs) {
    done++;
    figma.ui.postMessage({
      type: "progress",
      message: "Экспортирую ассеты " + done + "/" + assetRefs.length + "…",
    });
    const live = figma.getNodeById(ref.id);
    if (!live || typeof live.exportAsync !== "function") continue;
    try {
      if (ref.kind === "svg") {
        const bytes = await live.exportAsync({ format: "SVG" });
        assets.push({ id: ref.id, kind: "svg", bytes });
      } else if (ref.kind === "bg") {
        // Export the container's photo fill alone: hide direct children, snap
        // the PNG, then restore visibility (guarded so we never leave hidden).
        const hidden = [];
        for (const c of live.children || []) {
          if (c.visible) {
            c.visible = false;
            hidden.push(c);
          }
        }
        try {
          const bytes = await live.exportAsync({ format: "PNG", constraint: pngConstraint(live, 2048) });
          assets.push({ id: ref.id, kind: "png", bytes });
        } finally {
          for (const c of hidden) c.visible = true;
        }
      } else {
        const bytes = await live.exportAsync({ format: "PNG", constraint: pngConstraint(live, 2048) });
        assets.push({ id: ref.id, kind: "png", bytes });
      }
    } catch (e) {
      /* skip an asset that fails to export */
    }
  }

  // A flat PNG of the whole selection for the "Figma превью" tab.
  let preview = null;
  try {
    const top = sel.length === 1 ? sel[0] : figma.group(sel.slice(), figma.currentPage);
    // The preview is only shown fit-to-panel — 1600px is plenty.
    preview = await top.exportAsync({ format: "PNG", constraint: pngConstraint(top, 1600) });
    if (sel.length > 1 && top.type === "GROUP") figma.ungroup(top);
  } catch (e) {
    /* preview is optional */
  }

  let layerCount = 0;
  (function count(n) {
    layerCount++;
    for (const c of n.children || []) count(c);
  })(node);

  const variables = Array.from(ctx.tokens.values());

  figma.ui.postMessage({
    type: "payload",
    fileName: figma.root.name,
    node,
    assets,
    preview,
    variables,
    stats: { layers: layerCount, assets: assets.length, variables: variables.length },
  });
}

figma.ui.onmessage = (msg) => {
  if (msg.type === "send") run();
  else if (msg.type === "saveEndpoint") figma.clientStorage.setAsync("endpoint", msg.endpoint);
  else if (msg.type === "close") figma.closePlugin();
};
