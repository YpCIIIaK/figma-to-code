// Figma Copy companion — main thread (no DOM here).
// Serializes the current selection into the same shape the app's REST client
// produces (see src/lib/figma/types.ts), and exports each icon/image locally
// via exportAsync — so the app never touches Figma's rate-limited render API.

// The window is resizable (drag handle in the UI); start at the last size the
// designer left it at, clamped so a stale value can never strand the plugin
// off-screen or smaller than its own toolbar.
const MIN_W = 320, MIN_H = 320, MAX_W = 1600, MAX_H = 1200;
const clampW = (w) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w) || MIN_W));
const clampH = (h) => Math.max(MIN_H, Math.min(MAX_H, Math.round(h) || MIN_H));

figma.showUI(__html__, { width: 560, height: 560 });

figma.clientStorage.getAsync("uiSize").then((size) => {
  if (size && size.width && size.height)
    figma.ui.resize(clampW(size.width), clampH(size.height));
});

// Restore the saved app address and push a live selection count to the UI.
figma.clientStorage.getAsync("endpoint").then((ep) => {
  if (ep) figma.ui.postMessage({ type: "endpoint", endpoint: ep });
});

// Restore the saved conversion options (tokens / semantic / layout / responsive).
figma.clientStorage.getAsync("options").then((o) => {
  if (o) figma.ui.postMessage({ type: "options", options: o });
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
// The Plugin API and the REST API disagree on a few node type names, and this
// payload is meant to be REST-shaped. Left untranslated a triangle (POLYGON)
// misses VECTOR_TYPES and lands as a plain filled <div> — a square where the
// map pin's arrow should be.
const TYPE_ALIASES = {
  POLYGON: "REGULAR_POLYGON",
  // Figma Draw: a transform group is an ordinary group, and text bent along a
  // path has no REST (or CSS) equivalent — it only survives as a flat vector.
  TRANSFORM_GROUP: "GROUP",
  TEXT_PATH: "VECTOR",
};
const restType = (t) => TYPE_ALIASES[t] || t;
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
// Text bent around a circle — each letter/word is its own rotated TEXT node.
// CSS has no text-on-path, so the whole ring must flatten into one SVG asset.
function collectTextNodes(n, acc) {
  if (n.type === "TEXT") acc.push(n);
  for (const c of n.children || []) collectTextNodes(c, acc);
}
// A word laid out on a path: Figma splits it into one TEXT node per glyph.
// Rotation is no help (along a gentle arc each letter tilts a degree or two),
// but no hand-built layout splits a word into single-character layers. Left as
// HTML it explodes into dozens of absolutely-positioned <p>s.
function isSplitGlyphText(n) {
  const kids = n.children || [];
  if (kids.length < 5) return false;
  if (!kids.every(function (c) { return c.type === "TEXT"; })) return false;
  const glyphs = kids.filter(function (c) {
    return typeof c.characters === "string" && c.characters.trim().length <= 2;
  });
  return glyphs.length >= kids.length * 0.8;
}
/** Does this container hold a mask layer (which clips its later siblings)? */
function hasMaskedChild(n) {
  return (n.children || []).some(function (c) { return c.isMask; });
}
// Text a reader is meant to select: upright, more than one glyph. Rotated ring
// labels don't count — those only survive flattened into an SVG anyway.
function subtreeHasRealText(n) {
  if (
    n.type === "TEXT" &&
    (!isNum(n.rotation) || Math.abs(n.rotation) <= 10) &&
    typeof n.characters === "string" &&
    n.characters.trim().length > 1
  )
    return true;
  return (n.children || []).some(subtreeHasRealText);
}
function isTextRing(n) {
  // Tight on purpose: a whole section that merely contains a ringed chart
  // label must not collapse into one flat image. Demand real ring geometry —
  // a roughly square box, short labels, centres at a consistent radius.
  // A ring is a flat bag of glyph/word layers; a container of frames is a
  // section that merely holds one, and must not be flattened.
  const kids = n.children || [];
  if (!kids.length || !kids.every(function (c) { return c.type === "TEXT"; })) return false;
  const texts = [];
  collectTextNodes(n, texts);
  if (texts.length < 3 || texts.length > 80) return false;
  const rotated = texts.filter(function (t) {
    return isNum(t.rotation) && Math.abs(t.rotation) > 10;
  });
  if (rotated.length < texts.length * 0.6) return false;
  for (const t of rotated)
    if (typeof t.characters === "string" && t.characters.length > 40) return false;
  const box = n.absoluteBoundingBox;
  if (!box || !box.width || !box.height) return false;
  const aspect = box.width / box.height;
  if (aspect < 0.5 || aspect > 2) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radii = [];
  for (const t of rotated) {
    const b = t.absoluteBoundingBox;
    if (!b) return false;
    const dx = b.x + b.width / 2 - cx;
    const dy = b.y + b.height / 2 - cy;
    radii.push(Math.sqrt(dx * dx + dy * dy));
  }
  const max = Math.max.apply(null, radii);
  const min = Math.min.apply(null, radii);
  return max > 0 && min >= max * 0.5;
}
// Text bent along a path (Figma Draw "text on a path") has no CSS equivalent —
// only an SVG export reproduces it. Detect via the API marker when Figma
// exposes one, else by geometry: a straight text block is ~lines × lineHeight
// tall, while path text produces a box far taller than any line count explains
// (a ring is roughly square).
function isCurvedText(node) {
  if (node.type !== "TEXT") return false;
  if (node.textPath || node.textPathData) return true;
  const chars = typeof node.characters === "string" ? node.characters : "";
  if (!chars) return false;
  const w = node.width;
  const h = node.height;
  if (!isNum(w) || !isNum(h) || !w || !h) return false;
  const fs = isNum(node.fontSize) ? node.fontSize : 14;
  const lineH = fs * 1.5;
  // Худшая (максимальная) оценка числа строк при переносе по ширине бокса.
  const perLine = Math.max(1, Math.floor(w / (fs * 0.55)));
  let lines = 0;
  for (const part of chars.split("\n"))
    lines += Math.max(1, Math.ceil(part.length / perLine));
  return h > Math.max(lineH, lines * lineH) * 2.2;
}
function isIconNode(n) {
  if (VECTOR_TYPES.indexOf(n.type) !== -1) return true;
  if (isArcEllipse(n)) return true;
  var isContainer = CONTAINER_TYPES.indexOf(n.type) !== -1;
  // Honour the serialized svgExport mark (designer's "Export as SVG" or curved
  // text detected below) — collectAssets walks the serialized tree. But a
  // container full of real text stays HTML: designers routinely leave export
  // settings on a whole section, and obeying that flattens it into a picture.
  if (n.svgExport && !hasImageFill(n) && !(isContainer && subtreeHasRealText(n)))
    return true;
  if (isContainer && n.children && n.children.length) {
    // A photo (image fill) is never an icon — flattening it to SVG embeds the
    // raster and bloats the code; let it become a background image instead.
    if (hasImageFill(n)) return false;
    // A vector mask (a country outline clipping a filled rectangle, say) has no
    // CSS equivalent — layer by layer it degrades into a solid block the size
    // of the group. One flattened SVG is the only faithful output.
    if (hasMaskedChild(n) && !subtreeHasRealText(n)) return true;
    // Ordinary text keeps the container HTML; a circular-text ring is the
    // exception — it only survives as a flattened SVG.
    if (isSplitGlyphText(n)) return true;
    if (subtreeHasText(n)) return isTextRing(n);
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
// A video fill counts as an image: exportAsync renders the clip's first frame,
// so it becomes a still poster instead of an empty box.
function isImagePaint(f) {
  return f.visible !== false && (f.type === "IMAGE" || f.type === "VIDEO");
}
/** Does anything in this subtree paint a bitmap (photo / video fill)? */
function subtreeHasImageFill(n) {
  if (hasImageFill(n)) return true;
  return (n.children || []).some(subtreeHasImageFill);
}
function hasImageFill(n) {
  return Array.isArray(n.fills) && n.fills.some(isImagePaint);
}

// A prototype reaction (OPEN_URL / navigate) is a far more reliable signal of a
// real link/button than guessing from the layer name — surface it to the app.
// Figma easing → CSS timing function. Springs have no CSS equivalent; an
// ease-out curve is the closest single-curve stand-in.
const EASING_CSS = {
  LINEAR: "linear",
  EASE_IN: "cubic-bezier(0.42,0,1,1)",
  EASE_OUT: "cubic-bezier(0,0,0.58,1)",
  EASE_IN_AND_OUT: "cubic-bezier(0.42,0,0.58,1)",
  EASE_IN_BACK: "cubic-bezier(0.3,-0.05,0.7,-0.5)",
  EASE_OUT_BACK: "cubic-bezier(0.45,1.45,0.8,1)",
  EASE_IN_AND_OUT_BACK: "cubic-bezier(0.7,-0.4,0.4,1.4)",
  GENTLE: "cubic-bezier(0.25,1,0.5,1)",
  QUICK: "cubic-bezier(0.2,0.9,0.3,1)",
  BOUNCY: "cubic-bezier(0.34,1.56,0.64,1)",
  SLOW: "cubic-bezier(0.16,1,0.3,1)",
};

function easingCss(e) {
  if (!e) return undefined;
  if (e.type === "CUSTOM_CUBIC_BEZIER" && e.easingFunctionCubicBezier) {
    const b = e.easingFunctionCubicBezier;
    return "cubic-bezier(" + [b.x1, b.y1, b.x2, b.y2].map((v) => +v.toFixed(3)).join(",") + ")";
  }
  return EASING_CSS[e.type];
}

/** "While hovering / pressing → Change to <variant>" → a pending state ref,
 *  resolved to the serialized variant after the tree is built (resolveStates). */
function tagStates(node, out) {
  const rs = node.reactions;
  if (!Array.isArray(rs)) return;
  for (const rx of rs) {
    const t = rx.trigger && rx.trigger.type;
    const trigger = t === "ON_HOVER" || t === "MOUSE_ENTER" ? "hover" : t === "ON_PRESS" ? "press" : null;
    if (!trigger) continue;
    const acts = rx.actions || (rx.action ? [rx.action] : []);
    for (const a of acts) {
      if (!a || a.type !== "NODE" || a.navigation !== "CHANGE_TO" || !a.destinationId) continue;
      const tr = a.transition;
      (out._stateRefs = out._stateRefs || []).push({
        trigger,
        destinationId: a.destinationId,
        transition: tr
          ? { duration: Math.round((tr.duration || 0) * 1000), easing: easingCss(tr.easing) }
          : undefined,
      });
    }
  }
}

/** First "After delay → Change to" reaction of a live node, if any. */
function timeoutChange(node) {
  for (const rx of node.reactions || []) {
    if (!rx.trigger || rx.trigger.type !== "AFTER_TIMEOUT") continue;
    const acts = rx.actions || (rx.action ? [rx.action] : []);
    for (const a of acts) {
      if (a && a.type === "NODE" && a.navigation === "CHANGE_TO" && a.destinationId) {
        const tr = a.transition;
        return {
          delay: Math.round((rx.trigger.timeout || 0) * 1000),
          destinationId: a.destinationId,
          duration: tr ? Math.round((tr.duration || 0) * 1000) : 0,
          easing: tr ? easingCss(tr.easing) : undefined,
        };
      }
    }
  }
  return null;
}

/** "After delay → Change to" chains (A → B → … → A loops) → autoAnimation:
 *  the ordered variant states with their hold times and transitions. */
async function resolveAutoAnimations(root, ctx) {
  const pending = [];
  (function walk(n) {
    if (n._autoRef) pending.push(n);
    for (const c of n.children || []) walk(c);
  })(root);
  for (const n of pending) {
    const first = n._autoRef;
    delete n._autoRef;
    const live = await figma.getNodeByIdAsync(n.id);
    // The chain comes back to the *variant* this instance shows, not the instance.
    let homeId = n.id;
    if (live && live.type === "INSTANCE") {
      const mc = await live.getMainComponentAsync();
      if (mc) homeId = mc.id;
    }
    const steps = [];
    const seen = new Set([homeId, n.id]);
    let hop = first;
    let loops = false;
    while (hop && steps.length < 8) {
      if (seen.has(hop.destinationId)) {
        loops = true;
        steps.push({ delay: hop.delay, duration: hop.duration, easing: hop.easing, node: null });
        break;
      }
      seen.add(hop.destinationId);
      const dest = await figma.getNodeByIdAsync(hop.destinationId);
      if (!dest) break;
      const node = serialize(dest, ctx);
      (function strip(x) {
        delete x._stateRefs;
        delete x._autoRef;
        for (const c of x.children || []) strip(c);
      })(node);
      steps.push({ delay: hop.delay, duration: hop.duration, easing: hop.easing, node });
      hop = timeoutChange(dest);
    }
    if (steps.some((s) => s.node)) n.autoAnimation = { steps, loops };
  }
}

/** Swap each pending state ref for the serialized destination variant. */
async function resolveStates(root, ctx) {
  const pending = [];
  (function walk(n) {
    if (n._stateRefs) pending.push(n);
    for (const c of n.children || []) walk(c);
  })(root);
  for (const n of pending) {
    const states = [];
    for (const ref of n._stateRefs) {
      if (states.some((s) => s.trigger === ref.trigger)) continue;
      const dest = await figma.getNodeByIdAsync(ref.destinationId);
      if (!dest) continue;
      const node = serialize(dest, ctx);
      // A variant's own reactions (mouse-leave back to default) are not states
      // of *this* element — drop them so nothing nests.
      (function strip(x) {
        delete x._stateRefs;
        delete x._autoRef;
        for (const c of x.children || []) strip(c);
      })(node);
      states.push({ trigger: ref.trigger, node, transition: ref.transition });
    }
    delete n._stateRefs;
    if (states.length) n.interactiveStates = states;
  }
}

function tagInteraction(node, out) {
  const rs = node.reactions;
  if (!Array.isArray(rs) || !rs.length) return;
  tagStates(node, out);
  const auto = timeoutChange(node);
  if (auto) out._autoRef = auto;
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

/** Shared-style props worth resolving to a design-system name. */
var STYLE_PROPS = ["textStyleId", "fillStyleId", "strokeStyleId", "effectStyleId"];

/** Collect every shared-style id used on a node (skipping figma.mixed). */
function styleIds(n, acc) {
  for (var i = 0; i < STYLE_PROPS.length; i++) {
    const v = n[STYLE_PROPS[i]];
    if (typeof v === "string" && v) acc.add(v);
  }
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
  const sids = new Set();
  async function walk(n) {
    boundIds(n.boundVariables, ids);
    styleIds(n, sids);
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

  // Classic shared styles ("Heading/H1", "Brand/Primary") live outside the
  // variables system, but carry the same designer intent — resolve their names.
  const styles = new Map();
  for (const id of sids) {
    try {
      const st = await figma.getStyleByIdAsync(id);
      if (st && st.name) styles.set(id, sanitizeVarName(st.name));
    } catch (e) {
      /* a style from an unloaded library — fall back to raw values */
    }
  }
  return { cache, comp, styles, tokens: new Map() };
}

/** Resolve one shared-style property to its sanitized design-system name. */
function styleNameOf(node, prop, ctx) {
  const id = node[prop];
  if (typeof id !== "string" || !id) return undefined;
  return ctx.styles.get(id);
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
  } else if (p.type === "IMAGE" || p.type === "VIDEO") {
    // scaleMode (FILL/FIT/TILE/CROP) decides object-fit / background-size.
    // A VIDEO paint carries the same sizing — it exports as its first frame.
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

/** SVG markup bigger than this is never worth inlining as a data URI. */
var SVG_MAX_BYTES = 96 * 1024;

/** True when an SVG export embeds a raster or is simply too big to inline. */
function svgIsBloated(bytes) {
  if (bytes.length > SVG_MAX_BYTES) return true;
  // Scan the raw bytes for "data:image/" without decoding the whole export.
  const needle = "data:image/";
  const head = needle.charCodeAt(0);
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (bytes[i] !== head) continue;
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Convert a live Figma node into the REST-shaped JSON the converter expects. */
function serialize(node, ctx) {
  const out = { id: node.id, name: node.name, type: restType(node.type) };
  if (node.visible === false) out.visible = false;
  // Shared-style names — the designer's own naming for this block's look.
  const fillStyle = styleNameOf(node, "fillStyleId", ctx);
  if (fillStyle) out.fillStyleName = fillStyle;
  const strokeStyle = styleNameOf(node, "strokeStyleId", ctx);
  if (strokeStyle) out.strokeStyleName = strokeStyle;
  const effectStyle = styleNameOf(node, "effectStyleId", ctx);
  if (effectStyle) out.effectStyleName = effectStyle;
  tagInteraction(node, out);

  const bb = node.absoluteBoundingBox;
  if (bb) out.absoluteBoundingBox = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  // A bare line has a zero-width box, but its export carries the stroke (and
  // arrowheads) — the app sizes the <img> from these render bounds instead.
  const rb = node.absoluteRenderBounds;
  if (rb && bb && (bb.width < 0.5 || bb.height < 0.5))
    out.absoluteRenderBounds = { x: rb.x, y: rb.y, width: rb.width, height: rb.height };
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
  // A mask layer clips its following siblings; the app flattens such a group
  // into one SVG, since CSS cannot clip to an arbitrary vector.
  if (node.isMask) out.isMask = true;

  // For a rotated node absoluteBoundingBox is the AABB of the *rotated* shape,
  // and the original size can't always be recovered from it (at 45° the
  // equations are singular — a circle would inflate by √2). Pass the real one.
  if (isNum(node.rotation) && Math.abs(node.rotation) > 0.001 && isNum(node.width) && isNum(node.height))
    out.size = { x: node.width, y: node.height };

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
    // Curved / path text can't be reproduced in CSS — mark it so both this
    // plugin (collectAssets) and the app flatten it into one SVG asset.
    if (isCurvedText(node)) out.svgExport = true;
    out.characters = node.characters;
    out.style = textStyle(node);
    // Resize mode decides whether the text has a fixed width (wraps) or hugs.
    if (node.textAutoResize) out.textAutoResize = node.textAutoResize;
    const fsv = varNameOf(node, "fontSize", ctx, "size");
    if (fsv) out.style.fontSizeVar = fsv;
    const tsn = styleNameOf(node, "textStyleId", ctx);
    if (tsn) out.style.textStyleName = tsn;
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
    // An "icon" built on a raster — a photo clipped by a vector mask — has no
    // vectors to preserve, and the app asks for it as a PNG. Exporting SVG here
    // would file it under assets.svg while the markup looks in assets.png, and
    // the picture would come out with an empty src.
    acc.push({ id: n.id, kind: subtreeHasImageFill(n) ? "png" : "svg" });
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
 * Figma crops an SVG export to what is visibly drawn. For a partial ellipse (a
 * loader arc) that is just the arc, so the picture's centre is not the circle's
 * centre — a spinner then wobbles round the wrong axis. Re-frame the export as
 * a square centred on the ellipse centre, big enough for the whole stroke.
 */
function centerArcSvg(live, bytes) {
  try {
    const arc = live.type === "ELLIPSE" && live.arcData;
    if (!arc || Math.abs(arc.endingAngle - arc.startingAngle) >= Math.PI * 2 - 0.01) return bytes;
    const rb = live.absoluteRenderBounds;
    const t = live.absoluteTransform;
    if (!rb || !t) return bytes;
    const cx = t[0][0] * live.width / 2 + t[0][1] * live.height / 2 + t[0][2];
    const cy = t[1][0] * live.width / 2 + t[1][1] * live.height / 2 + t[1][2];
    const R = Math.max(
      cx - rb.x, rb.x + rb.width - cx, cy - rb.y, rb.y + rb.height - cy,
      live.width / 2, live.height / 2,
    );
    const vb = [cx - R - rb.x, cy - R - rb.y, 2 * R, 2 * R].map((v) => +v.toFixed(3)).join(" ");
    const text = String.fromCharCode.apply(null, Array.from(bytes));
    const out = text.replace(/<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/\s(width|height|viewBox)="[^"]*"/g, "")
        .replace(/<svg\b/,'<svg width="' + 2 * R + '" height="' + 2 * R + '" viewBox="' + vb + '"'),
    );
    const enc = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) enc[i] = out.charCodeAt(i) & 0xff;
    return enc;
  } catch (e) {
    return bytes;
  }
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
    const box = { x, y, width: x2 - x, height: y2 - y };
    // Picking a few blocks out of a page loses whatever painted behind them —
    // the page frame's own fill and the glow/stripe layers stacked under them.
    // When they share a parent, bring that backdrop along: the parent's fills
    // and every unselected sibling below them that overlaps the selection.
    const parent = sel[0].parent;
    const sameParent = parent && sel.every((s) => s.parent === parent) && "children" in parent;
    let ordered = sel.slice();
    let backdrop = [];
    let fills;
    if (sameParent) {
      const kids = parent.children;
      ordered.sort((a, b) => kids.indexOf(a) - kids.indexOf(b)); // z-order, not click order
      const lowest = kids.indexOf(ordered[0]);
      backdrop = kids.slice(0, lowest).filter((c) => {
        const b = c.absoluteBoundingBox;
        return (
          c.visible && b &&
          b.x < box.x + box.width && b.x + b.width > box.x &&
          b.y < box.y + box.height && b.y + b.height > box.y
        );
      });
      // Image fills would need an export of the parent itself — keep only the
      // paints CSS can draw (solid / gradients).
      if (Array.isArray(parent.fills))
        fills = parent.fills.filter((f) => f.type !== "IMAGE" && f.type !== "VIDEO").map(paintToRest);
    }
    node = {
      id: "selection",
      name: "Selection",
      type: backdrop.length || (fills && fills.length) ? "FRAME" : "GROUP",
      layoutMode: "NONE",
      absoluteBoundingBox: box,
      ...(fills && fills.length ? { fills } : {}),
      ...(backdrop.length || (fills && fills.length) ? { clipsContent: true } : {}),
      children: [...backdrop, ...ordered].map((s) => serialize(s, ctx)),
    };
  }

  await resolveStates(node, ctx);
  await resolveAutoAnimations(node, ctx);

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
    const live = await figma.getNodeByIdAsync(ref.id);
    if (!live || typeof live.exportAsync !== "function") continue;
    try {
      if (ref.kind === "svg") {
        const bytes = await live.exportAsync({ format: "SVG" });
        // A vector whose fills are images comes back as SVG with the whole
        // bitmap inlined as base64 - once URI-encoded that is several times
        // larger than the plain PNG, so ship the PNG instead.
        if (svgIsBloated(bytes)) {
          const raster = await live.exportAsync({
            format: "PNG",
            constraint: pngConstraint(live, 2048),
          });
          assets.push({ id: ref.id, kind: "svg", raster: true, bytes: raster });
        } else {
          assets.push({ id: ref.id, kind: "svg", bytes: centerArcSvg(live, bytes) });
        }
      } else if (ref.kind === "bg") {
        // Export the container's own fills without its children. Never hide the
        // children to do it: toggling visibility re-flows a hugging frame, and
        // constrained (Scale/Stretch) layers resized along with it do not come
        // back where they were — the designer's file got damaged. Paint the
        // fills onto a throwaway rectangle instead and delete it afterwards.
        const rect = figma.createRectangle();
        try {
          rect.resize(Math.max(1, live.width), Math.max(1, live.height));
          rect.x = -100000;
          rect.y = -100000;
          rect.fills = live.fills;
          if (typeof live.cornerRadius === "number") rect.cornerRadius = live.cornerRadius;
          else if (typeof live.topLeftRadius === "number") {
            rect.topLeftRadius = live.topLeftRadius;
            rect.topRightRadius = live.topRightRadius;
            rect.bottomRightRadius = live.bottomRightRadius;
            rect.bottomLeftRadius = live.bottomLeftRadius;
          }
          const bytes = await rect.exportAsync({ format: "PNG", constraint: pngConstraint(live, 2048) });
          assets.push({ id: ref.id, kind: "png", bytes });
        } finally {
          rect.remove();
        }
      } else {
        const bytes = await live.exportAsync({ format: "PNG", constraint: pngConstraint(live, 2048) });
        assets.push({ id: ref.id, kind: "png", bytes });
      }
    } catch (e) {
      /* skip an asset that fails to export */
    }
  }

  // A flat PNG of the selection for the "Figma превью" tab. Read-only: the old
  // multi-select path grouped the layers on the page and ungrouped them, which
  // pulled them out of their frame for good and wrecked the designer's file.
  // Several layers → the first one stands in (the preview is a convenience).
  let preview = null;
  try {
    const top = sel[0];
    // The preview is only shown fit-to-panel — 1600px is plenty.
    preview = await top.exportAsync({ format: "PNG", constraint: pngConstraint(top, 1600) });
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
  else if (msg.type === "resize") {
    const w = clampW(msg.width), h = clampH(msg.height);
    figma.ui.resize(w, h);
    figma.clientStorage.setAsync("uiSize", { width: w, height: h });
  } else if (msg.type === "saveOptions") figma.clientStorage.setAsync("options", msg.options);
  else if (msg.type === "saveEndpoint") figma.clientStorage.setAsync("endpoint", msg.endpoint);
  else if (msg.type === "close") figma.closePlugin();
};
