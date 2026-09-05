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
          // GC in tests must see freshly uploaded orphans
          PHOTO_GC_GRACE_MS: "0",
          // The e2e suite makes far more than 60 admin calls/min; limiter logic is covered in durable.test.js
          RATE_LIMIT_DISABLED: "1"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.js"]
  }
});
