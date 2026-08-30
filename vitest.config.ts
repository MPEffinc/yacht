import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
