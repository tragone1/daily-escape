import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    open: true,
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
