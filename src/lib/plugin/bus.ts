// In-memory relay between the Figma plugin (which POSTs a design payload) and
// the web app (which subscribes over SSE). Single-process, local-dev scope —
// good enough for one user driving the plugin and the app side by side.

type Listener = (data: string) => void;

const listeners = new Set<Listener>();
let latest: string | null = null;

/** Push a new payload (raw JSON string) to every connected app tab. */
export function publish(data: string): void {
  latest = data;
  for (const fn of listeners) {
    try {
      fn(data);
    } catch {
      /* a dead stream shouldn't break the others */
    }
  }
}

/** Subscribe an SSE stream; returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The most recent payload, so a tab that connects late still gets it. */
export function getLatest(): string | null {
  return latest;
}
