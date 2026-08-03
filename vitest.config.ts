import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The world tests build whole courses; a generous ceiling keeps a slow
    // machine from failing a suite that is only doing arithmetic.
    testTimeout: 60_000,
    include: ["src/**/*.test.ts"],
  },
});
