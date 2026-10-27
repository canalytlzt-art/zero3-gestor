import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(
  resolve(packageDirectory, "../../scripts/d1/migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(packageDirectory, "src/worker/index.ts"),
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-10-26",
        d1Databases: { DB: "zero3-vitest-local-only" },
        bindings: {
          TEST_MIGRATIONS: migrations,
          CLERK_SECRET_KEY: "sk_test_fixture_not_a_credential",
          CLERK_JWT_KEY: "local-vitest-placeholder",
          CLERK_ISSUER: "https://clerk.zero3.test",
          CLERK_AUTHORIZED_PARTIES: "https://zero3.test",
          ZERO3_ALLOWED_EMAILS: "worker-test@example.invalid",
        },
      },
    }),
  ],
  test: {
    include: ["src/worker/**/*.workers.test.ts"],
    setupFiles: ["./src/worker/workers-test-setup.mjs"],
  },
});
