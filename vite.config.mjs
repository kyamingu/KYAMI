import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  // This local-only test config deliberately has no Workers AI binding. Every
  // test passes a mocked AI object, avoiding authentication and quota use.
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    fileParallelism: false,
  },
});
