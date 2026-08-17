import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);

const EXPECTED_MANAGER_KNOWLEDGE_ERRORS = new Set([
  "Manager Knowledge integrity_failure: duplicate connected account.",
  "This Manager runtime is private and cannot be shared.",
  "A private Manager runtime cannot keep shared users.",
  "You don't have access to this workspace.",
  "Action is not reviewable.",
  "Gadget restarted to revoke access for a removed collaborator.",
  "The execution context which hosts this callback is no longer running.",
]);

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__integration__/manager-knowledge-worker.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        serviceBindings: {
          MANAGER_NATIVE_REGRESSION: {
            name: kCurrentWorker,
            entrypoint: "ManagerNativeRegressionEntrypoint",
          },
          GATEKEEPER_CUSTOM: { name: kCurrentWorker, entrypoint: "ManagerKnowledgeTestVendor" },
          MANAGER_KNOWLEDGE_BRIDGE: { name: kCurrentWorker, entrypoint: "ManagerKnowledgeBridge" },
          MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: {
            name: kCurrentWorker,
            entrypoint: "ManagerKnowledgeTestCapabilityFactory",
          },
        },
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      const message =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : undefined;
      if (
        message !== undefined &&
        (EXPECTED_MANAGER_KNOWLEDGE_ERRORS.has(message) ||
          message.includes("This Manager runtime is private") ||
          message.includes("A private Manager runtime cannot keep shared users") ||
          message.includes("You don't have access to this workspace") ||
          /^capnweb-validate: refused /u.test(message) ||
          /^'[^']+' is not a function\.$/u.test(message))
      ) {
        return false;
      }
    },
  },
});
