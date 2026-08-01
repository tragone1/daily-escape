import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

/*
 * Debug incident collector. The ?debug overlay in the game POSTs every finished
 * juggernaut incident here (same origin, so it works from any browser), and it lands
 * in debug-incidents.log next to the project - which means a play session on this
 * machine leaves a record that can be read afterwards without the player doing
 * anything but playing.
 */
function debugLogCollector(): Plugin {
  return {
    name: "debug-log-collector",
    configureServer(server) {
      server.middlewares.use("/debug-log", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const line = new Date().toISOString() + " " + body.replace(/\n/g, " ") + "\n";
            fs.appendFileSync(path.join(process.cwd(), "debug-incidents.log"), line);
          } catch {
            /* logging must never break the game */
          }
          res.statusCode = 200;
          res.end("ok");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [debugLogCollector()],
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
