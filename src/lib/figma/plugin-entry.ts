// Bundle entry for the Figma plugin UI.
//
// esbuild rolls this up (see scripts/build-plugin.mjs) into a single IIFE that
// scripts/build-plugin.mjs inlines into figma-plugin/ui.html. The plugin then
// generates code entirely inside Figma -- no server, no localhost, nothing to
// run. Keep this file free of Node/browser-only APIs so the bundle stays pure.

import { generate, GenerateInputError } from "./generate";
import type { GenerateBody, GenerateResult } from "./generate";

/**
 * Same contract as POST /api/convert, minus the HTTP: returns the generated
 * code, or an { error } object so the UI can render failures identically to
 * the server path.
 */
function convert(body: GenerateBody): GenerateResult | { error: string } {
  try {
    return generate(body);
  } catch (e) {
    const err = e as Error;
    return { error: err.message ?? "Ошибка конвертации" };
  }
}

(globalThis as unknown as { FigmaCopyEngine: unknown }).FigmaCopyEngine = {
  convert,
  generate,
  GenerateInputError,
};
