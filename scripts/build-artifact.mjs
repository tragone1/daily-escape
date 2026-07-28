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
/* Start card. Deliberately single-theme: this is a night-time arcade screen, and the
   panel matches the in-game HUD chrome exactly (translucent, hairline, blurred). */
#focusHint {
  position: absolute; inset: 0; z-index: 50; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 50% 45%, rgba(5,7,12,.72), rgba(5,7,12,.94));
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #eaf0ff; padding: 24px;
}
#focusHint.hidden { display: none; }
#startCard {
  background: rgba(10,12,18,.78);
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 14px;
  backdrop-filter: blur(8px);
  padding: 34px 40px;
  max-width: 520px; width: 100%;
  display: flex; flex-direction: column; gap: 18px;
  text-align: center;
}
#startCard h2 {
  margin: 0; font-size: clamp(28px, 6vw, 42px); font-weight: 800;
  letter-spacing: .16em; color: #ffd23f; text-wrap: balance;
  text-shadow: 0 0 30px rgba(255,210,63,.35);
}
#startCard .tagline { margin: 0; font-size: 13px; line-height: 1.6; color: #b9c1d4; }
#startCard .tagline strong { color: #4dff9e; font-weight: 700; }
#startKeys {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px 14px; font-size: 11px; color: #8b93a7;
  border-top: 1px solid rgba(255,255,255,.1); padding-top: 16px;
}
#startKeys span { display: flex; align-items: center; justify-content: center; gap: 6px; }
#startKeys b {
  background: rgba(255,255,255,.1); border-radius: 4px; padding: 2px 6px;
  color: #eaf0ff; font-weight: 600;
}
#startGo {
  font: inherit; font-size: 13px; font-weight: 700; letter-spacing: .12em;
  color: #05070c; background: #ffd23f; border: none; border-radius: 8px;
  padding: 13px 30px; cursor: pointer; align-self: center;
}
#startGo:hover { filter: brightness(1.08); }
#startGo:focus-visible { outline: 2px solid #4dff9e; outline-offset: 3px; }
/* Build stamp. Present so a stale cached copy is identifiable at a glance rather than
   being mistaken for a bug in the current one. */
#buildStamp { margin: 0; font-size: 10px; letter-spacing: .1em; color: #5d6579; }

/* Surfaces a boot failure instead of leaving a silent black canvas. */
#bootError {
  position: absolute; inset: auto 16px 16px 16px; z-index: 60;
  background: rgba(40,10,12,.95); border: 1px solid #ff4d4d; border-radius: 10px;
  padding: 14px 16px; color: #ffd9d9; font-size: 12px; line-height: 1.5;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  max-height: 45vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
#bootError[hidden] { display: none; }
#bootError b { color: #ff4d4d; }
</style>

${body}

<div id="bootError" hidden></div>

<div id="focusHint">
  <div id="startCard">
    <h2>DAILY ESCAPE</h2>
    <p class="tagline">
      There is no finish line. Every section brings <strong>more police,
      heavier police and spike strips</strong> &mdash; drive until they box you in.
    </p>
    <div id="startKeys">
      <span><b>W A S D</b> drive</span>
      <span><b>Space</b> boost</span>
      <span><b>F</b> rocket</span>
      <span><b>R</b> restart</span>
      <span><b>C</b> camera</span>
      <span><b>Score</b> = how far you got</span>
    </div>
    <button id="startGo" type="button">START RUN</button>
    <p id="buildStamp">${stamp}</p>
  </div>
</div>

<script>
/*
 * Boot diagnostics.
 *
 * A WebGL game that fails to start is otherwise indistinguishable from a black screen,
 * which makes it impossible to tell a blocked script from a missing GPU context. This
 * captures whatever went wrong and puts it on the page.
 */
(function () {
  var box = document.getElementById("bootError");
  var seen = [];
  function report(what) {
    seen.push(what);
    if (!box) return;
    box.hidden = false;
    // Joined with markup rather than newline escapes: this whole block lives inside a
    // template literal, and a "\\n" here silently became a real line break inside a
    // string literal, which is a syntax error that took the start button down with it.
    box.innerHTML = "<b>Daily Escape could not start.</b><br>" + seen.join("<br>");
  }
  window.addEventListener("error", function (e) {
    report((e && e.message ? e.message : "script error") +
      (e && e.filename ? " @ " + e.filename : "") +
      (e && e.lineno ? ":" + e.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    report("promise rejection: " + (e && e.reason ? e.reason : "unknown"));
  });
  // If the bundle never ran at all, nothing above fires, so check explicitly.
  window.addEventListener("load", function () {
    setTimeout(function () {
      if (!window.__game) {
        report("Game object never initialised. The bundle did not execute " +
          "(inline script blocked, payload truncated, or WebGL unavailable).");
      }
    }, 1500);
  });
})();

(function () {
  var hint = document.getElementById("focusHint");
  function start() {
    if (hint) hint.classList.add("hidden");
    window.focus();
    var c = document.getElementById("renderCanvas");
    if (c) c.focus();
    if (window.__game) { window.__game.restart(); window.__game.begin(); }
  }
  if (hint) hint.addEventListener("click", start);
  var go = document.getElementById("startGo");
  if (go) go.addEventListener("click", function (e) { e.stopPropagation(); start(); });
  // Clicking anywhere in the frame later should also restore keyboard focus.
  window.addEventListener("mousedown", function () { window.focus(); });
})();
</script>

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
