// Server-side font store.
//
// Fonts used to live in localStorage as base64 data URIs, which blew the ~5 MB
// browser quota after two or three families and was invisible to the Figma
// plugin (a different origin with its own storage). They now live on disk next
// to the project: no quota, and both the web app and the plugin read the same
// set through /api/fonts.

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export interface StoredFace {
  /** stable id (family|weight|style) */
  id: string;
  fileName: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** CSS src format token: woff2 / woff / truetype / opentype */
  format: string;
  /** file on disk inside the store (never a path from the client) */
  file: string;
  /** raw byte size, for the UI */
  size: number;
}

const DIR = path.join(process.cwd(), ".fonts");
const INDEX = path.join(DIR, "index.json");

const EXT_OF_FORMAT: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  truetype: "ttf",
  opentype: "otf",
};

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
}

export async function readIndex(): Promise<StoredFace[]> {
  try {
    const list = JSON.parse(await fs.readFile(INDEX, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeIndex(faces: StoredFace[]) {
  await ensureDir();
  await fs.writeFile(INDEX, JSON.stringify(faces, null, 2), "utf8");
}

/** Replace the whole set: writes the new files, then drops orphaned ones. */
export async function saveFaces(
  incoming: {
    id: string;
    fileName: string;
    family: string;
    weight: number;
    style: "normal" | "italic";
    format: string;
    /** base64 payload — only for faces that are new to the store */
    base64?: string;
    /** existing file name, when the face is already stored */
    file?: string;
  }[],
): Promise<StoredFace[]> {
  await ensureDir();
  const kept: StoredFace[] = [];

  for (const f of incoming) {
    const ext = EXT_OF_FORMAT[f.format] ?? "bin";
    // Never let the upload payload itself into the index — the bytes belong in
    // the blob, and echoing them back would double every response.
    const meta: Omit<StoredFace, "file" | "size"> = {
      id: f.id,
      fileName: f.fileName,
      family: f.family,
      weight: f.weight,
      style: f.style,
      format: f.format,
    };
    if (f.base64) {
      const bytes = Buffer.from(f.base64, "base64");
      // Content-addressed: re-uploading the same file rewrites one blob rather
      // than piling up copies when the designer renames a family.
      const name = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16) + "." + ext;
      await fs.writeFile(path.join(DIR, name), bytes);
      kept.push({ ...meta, file: name, size: bytes.length });
    } else if (f.file) {
      // Metadata-only edit (family/weight renamed in the UI).
      const safe = path.basename(f.file);
      let size = 0;
      try {
        size = (await fs.stat(path.join(DIR, safe))).size;
      } catch {
        continue; // the blob is gone — drop the entry rather than emit a 404 face
      }
      kept.push({ ...meta, file: safe, size });
    }
  }

  await writeIndex(kept);

  // Sweep blobs no face points at any more.
  const inUse = new Set(kept.map((f) => f.file));
  for (const entry of await fs.readdir(DIR)) {
    if (entry === "index.json" || inUse.has(entry)) continue;
    await fs.rm(path.join(DIR, entry), { force: true });
  }
  return kept;
}

/** Read one face's bytes as a data URI (for @font-face embedding). */
export async function dataUri(face: StoredFace): Promise<string> {
  const ext = EXT_OF_FORMAT[face.format] ?? "bin";
  const bytes = await fs.readFile(path.join(DIR, path.basename(face.file)));
  return `data:font/${ext};base64,${bytes.toString("base64")}`;
}

/** @font-face CSS with the bytes embedded, optionally limited to families in use. */
export async function buildCss(faces: StoredFace[], familiesInUse?: string[]): Promise<string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = familiesInUse?.length ? new Set(familiesInUse.map(norm)) : null;
  const rules: string[] = [];
  for (const f of faces) {
    if (used && !used.has(norm(f.family))) continue;
    rules.push(
      `@font-face {\n  font-family: "${f.family}";\n  font-style: ${f.style};\n  font-weight: ${f.weight};\n  font-display: swap;\n  src: url(${await dataUri(f)}) format("${f.format}");\n}`,
    );
  }
  return rules.join("\n");
}
