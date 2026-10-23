import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

declare module "vitest" {
  interface ProvidedContext {
    cybernestOsTestPrivateJwk: string;
  }
}

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const privateJwk = JSON.stringify(await exportJWK(privateKey));
const publicJwk = JSON.stringify(await exportJWK(publicKey));
const proofIssuer = "https://proof-issuer.test.invalid";
const proofAudience = "cybernest-os-integration-test";
const proofEnvironment = "test";
const proofDeployment = "cybernest-os-integration";
const allowedOrigin = "https://workshop.invalid";

const EXPECTED_RPC_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
  "CHAT_HISTORY_MESSAGE_LIMIT_EXCEEDED",
  "CHAT_HISTORY_TEXT_LIMIT_EXCEEDED",
]);

const EXPECTED_MANAGER_KNOWLEDGE_ERRORS = new Set([
  "Manager Knowledge integrity_failure: duplicate connected account.",
  "Manager Knowledge integrity_failure: incompatible Gold controller contract.",
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
          GATEKEEPER_CUSTOM: { name: kCurrentWorker, entrypoint: "ManagerKnowledgeTestVendor" },
          MANAGER_KNOWLEDGE_BRIDGE: { name: kCurrentWorker, entrypoint: "ManagerKnowledgeBridge" },
          MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: {
            name: kCurrentWorker,
            entrypoint: "ManagerKnowledgeTestCapabilityFactory",
          },
        },
        bindings: {
          CYBERNEST_OS_PROOF_PUBLIC_JWK: publicJwk,
          CYBERNEST_OS_PROOF_ISSUER: proofIssuer,
          CYBERNEST_OS_PROOF_AUDIENCE: proofAudience,
          CYBERNEST_OS_PROOF_ENVIRONMENT: proofEnvironment,
          CYBERNEST_OS_PROOF_DEPLOYMENT: proofDeployment,
          CYBERNEST_OS_ALLOWED_ORIGINS: JSON.stringify([allowedOrigin]),
        },
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    provide: { cybernestOsTestPrivateJwk: privateJwk },
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_RPC_ERROR_CODES.has(code)) return false;
      const message =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : undefined;
      if (
        message !== undefined &&
        (message.includes("abortAllDurableObjects") ||
          message.includes("user-DO reset injected by test") ||
          EXPECTED_MANAGER_KNOWLEDGE_ERRORS.has(message))
      ) {
        return false;
      }
    },
  },
});
