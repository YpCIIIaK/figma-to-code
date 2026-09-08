// Custom web-font support: the user uploads the font files (or a .zip of them)
// that a Figma design uses, and we embed them as @font-face rules (base64 data
// URIs) so the live preview and the exported code render with the real fonts.
//
// The bytes live on the server (see src/lib/fonts-store.ts): localStorage's
// ~5 MB quota fits barely two families as base64, and the Figma plugin — a
// separate origin — could never see them. Both clients now read /api/fonts.

export interface FontFace {
  /** stable id (family|weight|style) for list keys + de-dupe */
  id: string;
  /** original file name, shown in the UI */
  fileName: string;
  /** CSS family name — must match the family string the design uses ("Gilroy",
   *  "Playfair Display") for the @font-face to actually apply. */
  family: string;
  /** 100–900 */
  weight: number;
  style: "normal" | "italic";
  /** CSS src format token: woff2 / woff / truetype / opentype */
  format: string;
  /** data:font/...;base64,... — set for a freshly read file, absent once stored */
  dataUri?: string;
  /** blob name in the server store — set for a face that is already saved */
  file?: string;
  /** raw byte size, for the UI */
  size?: number;
}

/** Faces the user uploaded before the store moved server-side. */
const LEGACY_KEY = "figma-copy-fonts";

function legacyFonts(): FontFace[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const list = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Read the stored set; migrates a legacy localStorage set on first run. */
export async function fetchFonts(): Promise<FontFace[]> {
  const res = await fetch("/api/fonts");
  if (!res.ok) throw new Error("Не удалось прочитать шрифты");
  const faces: FontFace[] = (await res.json()).faces ?? [];
  if (faces.length) return faces;

  const legacy = legacyFonts();
  if (!legacy.length) return faces;
  const migrated = await putFonts(legacy);
  // Only drop the old copy once the server confirms it has the bytes.
  if (migrated.ok) localStorage.removeItem(LEGACY_KEY);
  return migrated.faces ?? faces;
}

/** Replace the whole set on the server. */
export async function putFonts(
  faces: FontFace[],
): Promise<{ ok: boolean; error?: string; faces?: FontFace[] }> {
  try {
    const payload = faces.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      family: f.family,
      weight: f.weight,
      style: f.style,
      format: f.format,
      // A face read from disk keeps its blob; a freshly parsed one ships bytes.
      base64: f.dataUri ? f.dataUri.slice(f.dataUri.indexOf(",") + 1) : undefined,
      file: f.file,
    }));
    const res = await fetch("/api/fonts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faces: payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, faces: data.faces };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Сбой сети" };
  }
}

/** @font-face CSS (bytes embedded) for the families the design actually uses. */
export async function fetchFontCss(familiesInUse: string[]): Promise<string> {
  const q = new URLSearchParams({ css: "1", families: familiesInUse.join(",") });
  const res = await fetch(`/api/fonts?${q}`);
  if (!res.ok) return "";
  return (await res.json()).css ?? "";
}

export function faceId(family: string, weight: number, style: string): string {
  return `${family.toLowerCase()}|${weight}|${style}`;
}

// ---- Filename → family / weight / style heuristics ------------------------

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra[-_ ]?light|ultra[-_ ]?light/i, 200],
  [/semi[-_ ]?bold|demi[-_ ]?bold/i, 600], // before "light"/"bold" catch-alls
  [/extra[-_ ]?bold|ultra[-_ ]?bold/i, 800],
  [/light/i, 300],
  [/regular|normal|book/i, 400],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

const EXT_FORMAT: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

const FONT_EXTS = Object.keys(EXT_FORMAT);

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extOf(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

/** Best-guess {family, weight, style} from a font file name. */
export function guessMeta(fileName: string): {
  family: string;
  weight: number;
  style: "normal" | "italic";
} {
  const stem = basename(fileName).replace(/\.[^.]+$/, "");
  const style: "normal" | "italic" = /italic|oblique/i.test(stem)
    ? "italic"
    : "normal";
  let weight = 400;
  for (const [re, w] of WEIGHTS)
    if (re.test(stem)) {
      weight = w;
      break;
    }
  // Strip weight/style words and separators to recover the family name.
  const family = stem
    .replace(
      /[-_ ]?(thin|hairline|extra[-_ ]?light|ultra[-_ ]?light|semi[-_ ]?bold|demi[-_ ]?bold|extra[-_ ]?bold|ultra[-_ ]?bold|light|regular|normal|book|medium|black|heavy|bold|italic|oblique)/gi,
      "",
    )
    .replace(/[-_]+/g, " ")
    // CamelCase → spaced ("PlayfairDisplay" → "Playfair Display")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return { family: family || stem, weight, style };
}

/** Snap a guessed family to one of the design's real family strings when they
 *  match ignoring case/spacing (so "PlayfairDisplay" → "Playfair Display"). */
export function snapFamily(guess: string, designFamilies: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const g = norm(guess);
  const hit = designFamilies.find((f) => norm(f) === g);
  return hit ?? guess;
}

// ---- Reading uploaded files (font files or a .zip of them) ----------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extract entries from a ZIP via its central directory (STORE + DEFLATE). */
async function unzip(buf: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Locate the End Of Central Directory record (scan back from the end).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Jump to the local header to find where the file data actually starts.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
      if (data) out.push({ name, data });
    } catch {
      /* unsupported compression for this entry — skip it */
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function makeFace(name: string, bytes: Uint8Array): FontFace | null {
  const ext = extOf(name);
  const format = EXT_FORMAT[ext];
  if (!format) return null;
  const { family, weight, style } = guessMeta(name);
  const dataUri = `data:font/${ext};base64,${bytesToBase64(bytes)}`;
  return { id: faceId(family, weight, style), fileName: basename(name), family, weight, style, format, dataUri };
}

/** Turn a user file selection (font files and/or .zip archives) into faces. */
export async function readFontFiles(files: FileList | File[]): Promise<FontFace[]> {
  const faces: FontFace[] = [];
  for (const file of Array.from(files)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (extOf(file.name) === "zip") {
      const entries = await unzip(bytes);
      for (const e of entries) {
        if (FONT_EXTS.includes(extOf(e.name))) {
          const f = makeFace(e.name, e.data);
          if (f) faces.push(f);
        }
      }
    } else {
      const f = makeFace(file.name, bytes);
      if (f) faces.push(f);
    }
  }
  return faces;
}

// ---- @font-face CSS -------------------------------------------------------

/** Build the @font-face block. When `familiesInUse` is given, only faces whose
 *  family the design actually uses are emitted (skip dead weight). */
export function buildFontFaceCss(
  faces: FontFace[],
  familiesInUse?: string[],
): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = familiesInUse ? new Set(familiesInUse.map(norm)) : null;
  const rules = faces
    .filter((f) => f.dataUri && (!used || used.has(norm(f.family))))
    .map(
      (f) =>
        `@font-face {\n  font-family: "${f.family}";\n  font-style: ${f.style};\n  font-weight: ${f.weight};\n  font-display: swap;\n  src: url(${f.dataUri}) format("${f.format}");\n}`,
    );
  return rules.join("\n");
}
