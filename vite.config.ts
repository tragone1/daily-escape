import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/**
 * The build's identity, stamped in at compile time.
 *
 * A player reporting "it went black" is unactionable without knowing which
 * build they were running, and an old cached client talking to a newer API is
 * invisible from both ends unless one of them says what it is. Derived from
 * the commit so it needs no manual bumping; falls back to the timestamp
 * outside a git checkout, which is the case on a clean CI clone.
 */
function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __API_VERSION__: JSON.stringify(1),
  },
  server: {
    port: 5173,
    open: true,
    // Reachable from a phone on the same wifi, for touch-control testing.
    host: true,
  },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 6000,
    // Emit one JS file with no dynamic chunks. The shareable build inlines the whole
    // game into a single HTML file, and inlining is only practical without code
    // splitting — Babylon pulls in a lot of lazily-imported loaders we never use.
    rollupOptions: {
      output: {
        // One self-contained classic script. `iife` rather than an ES module because the
        // shareable build inlines this into a page whose host may treat inline module
        // scripts differently; a classic script has the fewest ways to be rejected.
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
});
