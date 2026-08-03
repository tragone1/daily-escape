import { defineConfig } from "vitest/config";

export default defineConfig({
  /*
   * `node:sqlite` is newer than Vite's list of Node builtins, so it tries to
   * resolve it as a package and fails. Marking it external hands it back to
   * Node, which has had it since v22.
   */
  ssr: { external: ["node:sqlite"] },
  test: {
    // The world tests build whole courses; a generous ceiling keeps a slow
    // machine from failing a suite that is only doing arithmetic.
    testTimeout: 60_000,
    include: ["src/**/*.test.ts", "functions/**/*.test.ts"],
    server: { deps: { external: ["node:sqlite"] } },
  },
});
