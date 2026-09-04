import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Workers AI has no local simulator; never open a remote session from tests.
      remoteBindings: false,
      miniflare: {
        // Test-only bindings/vars; production values come from wrangler secrets.
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          // Turnstile off in tests (also overrides any value from .dev.vars)
          TURNSTILE_SECRET_KEY: "",
          // Force multi-step album rename so the resumable path is exercised
          ALBUM_RENAME_BATCH: "1"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.js"]
  }
});
