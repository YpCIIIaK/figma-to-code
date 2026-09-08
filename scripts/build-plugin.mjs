// Bundle the conversion engine into figma-plugin/ui.html.
//
// The plugin UI is a single HTML document handed to Figma as-is: it cannot
// <script src> a sibling file, so the bundle has to be inlined between the
// ENGINE markers. The result is committed, so anyone importing the plugin from
// the manifest gets a working, server-free plugin without running a build.

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const UI = "figma-plugin/ui.html";
const START = "<!-- ENGINE:START -->";
const END = "<!-- ENGINE:END -->";

const result = await build({
  entryPoints: ["src/lib/figma/plugin-entry.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  write: false,
  legalComments: "none",
});

const code = result.outputFiles[0].text;

const html = readFileSync(UI, "utf8");
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0) {
  throw new Error(`markers ${START} / ${END} not found in ${UI}`);
}

// </script> inside the bundle would close the host tag early.
const safe = code.replaceAll("</script>", "<\/script>");

const next =
  html.slice(0, from + START.length) +
  `\n    <script>${safe}</script>\n    ` +
  html.slice(to);

writeFileSync(UI, next);
const kb = (safe.length / 1024).toFixed(0);
console.log(`inlined engine into ${UI} (${kb} KB)`);
