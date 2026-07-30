/**
 * Packs the built game into a single self-contained HTML fragment for publishing.
 *
 * Artifacts are served under a strict CSP that blocks every external request, so the
 * whole game (styles, markup and the entire JS bundle) has to live inline in one file. The published file is a *fragment*: no <html>, <head> or <body>, because the
 * host wraps it in its own skeleton.
 *
 * Usage: npm run build && node scripts/build-artifact.mjs [outfile]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outFile = process.argv[2] ?? join(root, "dist", "daily-escape.html");

const html = readFileSync(join(dist, "index.html"), "utf8");

/** Short, human-readable build id so a cached page can be told apart from a fresh one. */
const BUILD_ID = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(4, 12);

// The build emits exactly one JS chunk (inlineDynamicImports is on in vite.config).
const assets = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
if (assets.length !== 1) {
  throw new Error(
    `Expected a single JS chunk, found ${assets.length}: ${assets.join(", ")}. ` +
      `Check that build.rollupOptions.output.inlineDynamicImports is still enabled.`,
  );
}
const js = readFileSync(join(dist, "assets", assets[0]), "utf8");

/*
 * Make the whole file ASCII-only.
 *
 * The fragment carries no <meta charset> of its own — the host supplies the document
 * head — so any raw multi-byte character is at the mercy of whatever encoding the page
 * is served with. Getting that wrong turns the HUD's arrows and dashes into mojibake.
 * HTML gets numeric entities, JS gets \uXXXX escapes; both are encoding-proof.
 */
const asciiHtml = (text) => text.replace(/[^\x00-\x7F]/g, (c) => `&#${c.charCodeAt(0)};`);

const pick = (re, label) => {
  const m = html.match(re);
  if (!m) throw new Error(`Could not find ${label} in dist/index.html`);
  return m[1];
};

const styles = asciiHtml(pick(/<style>([\s\S]*?)<\/style>/, "<style> block"));
const body = asciiHtml(
  pick(/<body>([\s\S]*?)<\/body>/, "<body> content")
    // Drop the module script tag; the bundle is inlined below instead.
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .trim(),
);

/** A closing script tag inside the bundle would end our inline script early. */
const escaped = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const asciiJs = escaped.replace(/[^\x00-\x7F]/g, (c) =>
  "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
);
const safeJs = asciiJs;

const stamp = `BUILD ${BUILD_ID}`;

const out = `<style>
/* The host supplies <html>/<body>, so the game claims the full viewport from here. */
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #05070c; }
${styles}
</style>

${body.replace('id="buildStamp">', `id="buildStamp">${stamp}`)}



<script>

<script>
${safeJs}
</script>
`;

/*
 * Hard ASCII check on the finished file.
 *
 * The escaping above covers the bundle and the markup lifted out of index.html, but not
 * the boilerplate written directly in this file. One stray dash in a comment here is
 * enough to break the invariant the whole fragment relies on, and nothing else would have
 * caught it, so assert on the actual bytes going out.
 */
const stray = out.match(/[^\x00-\x7F]/);
if (stray) {
  const at = out.indexOf(stray[0]);
  throw new Error(
    `Non-ASCII character ${JSON.stringify(stray[0])} in the output near: ` +
      JSON.stringify(out.slice(Math.max(0, at - 60), at + 20)),
  );
}

writeFileSync(outFile, out, "utf8");
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`Wrote ${outFile} (${kb} kB)`);
