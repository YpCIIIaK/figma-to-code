import type {
  FigmaFileResponse,
  FigmaNodesResponse,
  FigmaImagesResponse,
} from "./types";

const API = "https://api.figma.com/v1";

export class FigmaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Parse a Figma file/design URL into its key and (optional) selected node id.
 * Supports:
 *   https://www.figma.com/file/<KEY>/<name>?node-id=1-23
 *   https://www.figma.com/design/<KEY>/<name>?node-id=1%3A23
 * Or a bare file key.
 */
export function parseFigmaUrl(input: string): { fileKey: string; nodeId?: string } {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  const fileKey = urlMatch ? urlMatch[1] : trimmed;

  let nodeId: string | undefined;
  try {
    const u = new URL(trimmed);
    const raw = u.searchParams.get("node-id");
    if (raw) nodeId = raw.replace(/-/g, ":"); // "1-23" -> "1:23"
  } catch {
    // not a URL — fine, no node id
  }
  return { fileKey, nodeId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rate-limit defenses for Figma's strict /images render endpoint.
// 1) A single-lane queue serializes render calls and spaces them out, so
//    concurrent requests (preview + assets + rapid clicking) never burst.
// 2) Large id lists are chunked so one call can't grow unbounded or time out.
// ---------------------------------------------------------------------------
const MIN_IMAGE_GAP_MS = 350; // minimum spacing between render calls
const IMAGE_CHUNK = 40; // max node ids per render request
let imageChain: Promise<unknown> = Promise.resolve();
let lastImageCall = 0;

/** Serialize a render call behind the queue and enforce a min interval. */
function enqueueImageCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const since = Date.now() - lastImageCall;
    if (since < MIN_IMAGE_GAP_MS) await sleep(MIN_IMAGE_GAP_MS - since);
    try {
      return await fn();
    } finally {
      lastImageCall = Date.now();
    }
  };
  const result = imageChain.then(run, run);
  // Keep the lane open even if this call rejects.
  imageChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run async tasks with a bounded concurrency (for CDN markup downloads). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function figmaFetch<T>(
  token: string,
  path: string,
  retries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: { "X-Figma-Token": token },
      cache: "no-store",
    });

    // Rate limited: respect Retry-After and back off (Figma /images is strict).
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const base =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 1000; // 1s, 2s, 4s, 8s
      // Cap the wait and add jitter to avoid thundering-herd retries.
      const wait = Math.min(base, 15000) + Math.floor(Math.random() * 400);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        if (body?.err) detail = body.err;
      } catch {
        /* ignore */
      }
      const msg =
        res.status === 429
          ? "Figma ограничил частоту запросов (429). Подождите несколько секунд."
          : `Figma API ${res.status}: ${detail}`;
      throw new FigmaError(msg, res.status);
    }
    return res.json() as Promise<T>;
  }
}

/** Fetch a whole file document. */
export function getFile(token: string, fileKey: string, depth?: number) {
  const q = depth ? `?depth=${depth}` : "";
  return figmaFetch<FigmaFileResponse>(token, `/files/${fileKey}${q}`);
}

/** Fetch one or more specific nodes (cheaper than the whole file). */
export function getNodes(token: string, fileKey: string, ids: string[]) {
  const q = encodeURIComponent(ids.join(","));
  return figmaFetch<FigmaNodesResponse>(token, `/files/${fileKey}/nodes?ids=${q}`);
}

/**
 * Render PNG/SVG previews for the given node ids.
 * Chunks large id lists and runs every render call through the serialized,
 * rate-limited queue so we never burst Figma's strict /images endpoint.
 */
export async function getImages(
  token: string,
  fileKey: string,
  ids: string[],
  format: "png" | "svg" | "jpg" = "png",
  scale = 2,
): Promise<FigmaImagesResponse> {
  const batches = chunk(ids, IMAGE_CHUNK);
  const merged: Record<string, string | null> = {};
  let err: string | null = null;

  for (const batch of batches) {
    const q = new URLSearchParams({
      ids: batch.join(","),
      format,
      scale: String(scale),
    });
    const res = await enqueueImageCall(() =>
      figmaFetch<FigmaImagesResponse>(token, `/images/${fileKey}?${q.toString()}`),
    );
    if (res.err) err = res.err;
    Object.assign(merged, res.images ?? {});
  }

  return { err, images: merged };
}
