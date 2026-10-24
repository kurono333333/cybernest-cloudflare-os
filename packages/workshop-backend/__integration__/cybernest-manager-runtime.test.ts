import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from "capnweb";
import { generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import {
  BLUEPRINT_SCREENSHOT_PATH_PREFIX,
  BLUEPRINT_SCREENSHOT_R2_PREFIX,
  CHAT_HISTORY_ERROR_CODES,
  getChatHistoryErrorCode,
  type AiChatMessage,
  type AiChatMetadata,
  type AuthenticatedApi,
  type CybernestConnectionBootstrapApi,
  type GadgetMetadataWithTimestamps,
  type Overseer,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, inject, it, vi } from "vitest";
import { SITE_LOGO_PATH } from "../src/site-logo.js";
import server from "../src/server";
import type { CompactionCheckpoint } from "../src/agent";
import { getServerConfig } from "../src/deployment-config.js";
import type { UserDirectoryDurableObject } from "../src/user-directory";

declare module "vitest" {
  interface ProvidedContext {
    cybernestOsTestPrivateJwk: string;
  }
}

const TEST_PROOF_ISSUER = "https://proof-issuer.test.invalid";
const TEST_PROOF_AUDIENCE = "cybernest-os-integration-test";
const TEST_PROOF_ENVIRONMENT = "test";
const TEST_PROOF_DEPLOYMENT = "cybernest-os-integration";
const TEST_ALLOWED_ORIGIN = "https://workshop.invalid";
const TEST_DISALLOWED_ORIGIN = "https://attacker.invalid";
const CONNECTION_DEADLINE_MS = 3_600_000;
const TEST_BLUEPRINT_ID = "format.spreadsheet";
const TEST_SCREENSHOT_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

type Session<T extends RpcTarget = AuthenticatedApi> = {
  api: RpcStub<T>;
  bootstrapApi?: RpcStub<CybernestConnectionBootstrapApi>;
  socket?: WebSocket;
  closeAt?: Promise<number>;
};

type ProductBootstrapApi = CybernestConnectionBootstrapApi;
type PresentProofResult = Awaited<
  ReturnType<RpcStub<ProductBootstrapRootProbeApi>["presentProof"]>
>;

type ProductBootstrapRootProbeApi = ProductBootstrapApi &
  Pick<AuthenticatedApi, "whoami"> &
  Pick<PublicApi, "ping" | "getServerConfig">;

type ConnectionProofOverrides = {
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  purpose?: string;
  environment?: string;
  deployment?: string;
  issuedAt?: number;
  expirationTime?: number;
  omitClaim?: "iss" | "aud" | "sub" | "purpose" | "environment" | "deployment" | "iat" | "exp";
  extraClaim?: string;
  extraHeader?: { kid?: string; jku?: string; x5u?: string; typ?: string };
  wrongSignature?: boolean;
};

const INVALID_CONNECTION_PROOF_CASES: Array<{
  name: string;
  overrides: (now: number) => ConnectionProofOverrides;
}> = [
  { name: "wrong issuer", overrides: () => ({ issuer: "https://other-issuer.test.invalid" }) },
  { name: "wrong audience", overrides: () => ({ audience: "other-audience" }) },
  {
    name: "audience containing an extra value",
    overrides: () => ({ audience: [TEST_PROOF_AUDIENCE, "other-audience"] }),
  },
  { name: "wrong environment", overrides: () => ({ environment: "production" }) },
  { name: "wrong deployment", overrides: () => ({ deployment: "other-deployment" }) },
  { name: "non-UUID subject", overrides: () => ({ subject: "not-a-uuid" }) },
  { name: "wrong purpose", overrides: () => ({ purpose: "manager_session" }) },
  { name: "missing issuer", overrides: () => ({ omitClaim: "iss" }) },
  { name: "missing audience", overrides: () => ({ omitClaim: "aud" }) },
  { name: "missing subject", overrides: () => ({ omitClaim: "sub" }) },
  { name: "missing purpose", overrides: () => ({ omitClaim: "purpose" }) },
  { name: "missing environment", overrides: () => ({ omitClaim: "environment" }) },
  { name: "missing deployment", overrides: () => ({ omitClaim: "deployment" }) },
  { name: "missing issued-at claim", overrides: () => ({ omitClaim: "iat" }) },
  { name: "missing expiration claim", overrides: () => ({ omitClaim: "exp" }) },
  {
    name: "expired proof",
    overrides: (now) => ({ issuedAt: now - 61, expirationTime: now - 1 }),
  },
  {
    name: "non-positive proof lifetime",
    overrides: (now) => ({ issuedAt: now, expirationTime: now }),
  },
  {
    name: "proof lifetime over 60 seconds",
    overrides: (now) => ({ issuedAt: now, expirationTime: now + 61 }),
  },
  {
    name: "future issued-at claim",
    overrides: (now) => ({ issuedAt: now + 1, expirationTime: now + 60 }),
  },
  { name: "extra claim", overrides: () => ({ extraClaim: "unexpected" }) },
  { name: "extra kid header", overrides: () => ({ extraHeader: { kid: "unexpected" } }) },
  {
    name: "extra jku header",
    overrides: () => ({ extraHeader: { jku: "https://keys.invalid/jwks" } }),
  },
  {
    name: "extra x5u header",
    overrides: () => ({ extraHeader: { x5u: "https://keys.invalid/cert" } }),
  },
  { name: "wrong typ header", overrides: () => ({ extraHeader: { typ: "JWT" } }) },
  { name: "wrong signature", overrides: () => ({ wrongSignature: true }) },
];

type LegacySharingFixture = {
  addCollaborator(input: {
    caller: {profileId: string; isOwner: boolean};
    profile: {type: "user"; id: string; name: string};
    role: "use";
    note?: string;
  }): unknown;
  createShareLink(input: {
    caller: {profileId: string; isOwner: boolean};
    role: "use";
    note?: string;
  }): Promise<{key: string; linkId: string}>;
  isCollaborator(profileId: string): boolean;
};

type WorkspaceStorageFixture = {
  impl: {
    storage: {
      ownerId: {get(): string | undefined};
      chatMeta: {list(): Iterable<unknown>};
      externalChats: {list(): Iterable<unknown>};
    };
  };
};

type ChatHistoryStorageFixture = {
  impl: {
    storage: {
      chats: {
        put(message: AiChatMessage): void;
        list(): Iterable<AiChatMessage>;
      };
      chatMeta: {
        get(chatId: number): AiChatMetadata | undefined;
        put(metadata: AiChatMetadata): void;
      };
      chatCompactions: {
        put(checkpoint: CompactionCheckpoint): void;
        list(): Iterable<CompactionCheckpoint>;
      };
    };
  };
};

type ChatHistorySnapshot = {
  messages: AiChatMessage[];
  metadata: AiChatMetadata | undefined;
  checkpoints: CompactionCheckpoint[];
};

type CodedError = Error & {code?: unknown};

const historyAuthor = {type: "user" as const, id: "history-user", name: "History User"};

const managerId = (): string => crypto.randomUUID();

const managerHeaders = (id: string): HeadersInit => ({
  "X-Cybernest-Manager-Id": id,
});

const privateManagerHeaders = (
    id: string, leaseExpiresAt = Date.now() + 299_000): HeadersInit => ({
  ...managerHeaders(id),
  "X-Cybernest-Private-Lease-Expires-At": String(leaseExpiresAt),
});

async function connectionProof(
  id: string,
  overrides: ConnectionProofOverrides = {},
): Promise<string> {
  const signingKey = overrides.wrongSignature
    ? (await generateKeyPair("ES256")).privateKey
    : await importJWK(JSON.parse(inject("cybernestOsTestPrivateJwk")) as JWK, "ES256");
  const now = Math.floor(Date.now() / 1_000);
  const proof = new SignJWT({
    ...(overrides.omitClaim === "purpose" ? {} : { purpose: overrides.purpose ?? "os_connection" }),
    ...(overrides.omitClaim === "environment"
      ? {}
      : { environment: overrides.environment ?? TEST_PROOF_ENVIRONMENT }),
    ...(overrides.omitClaim === "deployment"
      ? {}
      : { deployment: overrides.deployment ?? TEST_PROOF_DEPLOYMENT }),
    ...(overrides.extraClaim === undefined ? {} : { unexpected: overrides.extraClaim }),
  }).setProtectedHeader({
    alg: "ES256",
    typ: "cybernest-os-connection+jwt",
    ...overrides.extraHeader,
  });
  if (overrides.omitClaim !== "iss") proof.setIssuer(overrides.issuer ?? TEST_PROOF_ISSUER);
  if (overrides.omitClaim !== "aud") {
    proof.setAudience(overrides.audience ?? TEST_PROOF_AUDIENCE);
  }
  if (overrides.omitClaim !== "sub") proof.setSubject(overrides.subject ?? id);
  if (overrides.omitClaim !== "iat") proof.setIssuedAt(overrides.issuedAt ?? now);
  if (overrides.omitClaim !== "exp") proof.setExpirationTime(overrides.expirationTime ?? now + 60);
  return proof.sign(signingKey);
}

async function openProductBootstrap(
  options: {
    origin?: string;
    headers?: HeadersInit;
  } = {},
): Promise<Session<ProductBootstrapRootProbeApi>> {
  const headers = new Headers(options.headers);
  headers.set("Upgrade", "websocket");
  if (options.origin !== undefined) headers.set("Origin", options.origin);
  // A service-binding fetch context ends with the upgrade response.
  // Invoke the handler directly so the WebSocket session shares the test's execution context.
  const response = await server.fetch(
    new Request("https://workshop.invalid/api", {
      headers,
    }),
    env,
    createExecutionContext(),
  );

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  const closeAt = new Promise<number>((resolve) => {
    const recordClose = (): void => resolve(Date.now());
    socket.addEventListener("close", recordClose, { once: true });
    if (socket.readyState === WebSocket.CLOSED) recordClose();
  });
  return {
    socket,
    closeAt,
    api: newWebSocketRpcSession<ProductBootstrapRootProbeApi>(socket),
  };
}

async function connectProductNative(id: string): Promise<Session> {
  const bootstrap = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
  try {
    const api = await presentProductApi(bootstrap.api, await connectionProof(id));
    return { socket: bootstrap.socket, api, bootstrapApi: bootstrap.api };
  } catch (error) {
    close(bootstrap);
    throw error;
  }
}

async function ensure(id: string): Promise<void> {
  const session = await connectProductNative(id);
  try {
    await session.api.whoami();
  } finally {
    close(session);
  }
}

async function seedExistingManagerProfile(id: string): Promise<void> {
  const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(id));
  await user.ensureCybernestManager(id);
}

async function managerProfile(id: string) {
  return exports.UserDurableObject.get(exports.UserDurableObject.idFromName(id)).whoamiIfExists();
}

type DirectorySqlFixture = {
  ctx: {
    storage: {
      sql: {
        exec(query: string, ...values: (string | number)[]): unknown;
      };
    };
  };
};

type UserDirectoryRevisionsFixture = {
  storage: {
    profileRev: { get(): number };
    directoryRev: { get(): number };
  };
};

async function directoryRevisions(id: string): Promise<{
  profileRev: number;
  directoryRev: number;
}> {
  const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(id));
  return runInDurableObject(user, async (instance) => {
    const storage = (instance as unknown as UserDirectoryRevisionsFixture).storage;
    return {
      profileRev: storage.profileRev.get(),
      directoryRev: storage.directoryRev.get(),
    };
  });
}

function directoryFailureTriggerName(id: string): string {
  return `cybernest_test_fail_directory_${id.replaceAll("-", "")}`;
}

async function createDirectoryFailureTrigger(id: string): Promise<void> {
  const triggerName = directoryFailureTriggerName(id);
  const directory = exports.UserDirectoryDurableObject.getByName("");
  await runInDurableObject(directory, async (instance) => {
    (instance as unknown as DirectorySqlFixture).ctx.storage.sql.exec(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON users
       WHEN NEW.id = '${id}' BEGIN
         SELECT RAISE(ABORT, 'synthetic directory sync failure');
       END`,
    );
  });
}

async function dropDirectoryFailureTrigger(id: string): Promise<void> {
  const triggerName = directoryFailureTriggerName(id);
  const directory = exports.UserDirectoryDurableObject.getByName("");
  await runInDurableObject(directory, async (instance) => {
    (instance as unknown as DirectorySqlFixture).ctx.storage.sql.exec(
      `DROP TRIGGER IF EXISTS ${triggerName}`,
    );
  });
}

function close<T extends RpcTarget>(session: Session<T>): void {
  session.api[Symbol.dispose]();
  session.bootstrapApi?.[Symbol.dispose]();
  session.socket?.close();
}

async function presentProductProof(
  bootstrapApi: RpcStub<ProductBootstrapRootProbeApi>,
  proof: string,
): Promise<PresentProofResult> {
  return await bootstrapApi.presentProof(proof);
}

function disposeProofResult(value: PresentProofResult): void {
  value[Symbol.dispose]();
}

function expectPresentProofResult(value: PresentProofResult): void {
  expect(Object.keys(value).toSorted()).toEqual(["authenticatedApi", "serverConfig"]);
}

async function presentProductApi(
  bootstrapApi: RpcStub<ProductBootstrapRootProbeApi>,
  proof: string,
): Promise<RpcStub<AuthenticatedApi>> {
  const result = await presentProductProof(bootstrapApi, proof);
  try {
    return result.authenticatedApi.dup();
  } finally {
    disposeProofResult(result);
  }
}

async function expectValidatorRejection(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toThrow(
      /^(?:capnweb-validate: refused |'[^']+' is not a function\.$)/u,
  );
}

async function waitForSocketClose(closeAt: Promise<number>, timeoutMs: number): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closeAt,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("WebSocket did not close before its deadline.")),
            timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type RpcOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

async function settleRpcWithin<T>(
    call: PromiseLike<T>, timeoutMs: number): Promise<RpcOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(call).then(
          (value): RpcOutcome<T> => ({ status: "resolved", value }),
          (reason: unknown): RpcOutcome<T> => ({ status: "rejected", reason }),
      ),
      new Promise<RpcOutcome<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForGadget(
  api: RpcStub<AuthenticatedApi>,
  id: string,
): Promise<GadgetMetadataWithTimestamps> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const gadget = (await api.listGadgets()).find((item) => item.id === id);
    if (gadget) return gadget;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Gadget ${id}.`);
}

function historyMessage(chatId: number, sequence: number, text: string): AiChatMessage {
  return {
    chatId,
    sequence,
    timestamp: new Date(sequence),
    author: historyAuthor,
    type: "message",
    message: text,
  };
}

function historyCheckpoint(
  chatId: number,
  compactedTo: number,
  summary: string,
): CompactionCheckpoint {
  return {
    chatId,
    compactedTo,
    summary,
    chatBindings: [],
    nextChangeId: 1,
  };
}

async function seedHistory(
    workspaceId: string,
    chatId: number,
    messages: AiChatMessage[],
    checkpoints: CompactionCheckpoint[] = [],
    activeCompactedTo?: number,
): Promise<void> {
  const stub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
  );
  await runInDurableObject(stub, async (instance) => {
    const storage = (instance as unknown as ChatHistoryStorageFixture).impl.storage;
    storage.chatMeta.put({
      id: chatId,
      title: `History ${chatId}`,
      started: new Date(0),
      lastActive: new Date(messages.at(-1)?.timestamp.valueOf() ?? 0),
      ...(activeCompactedTo === undefined ? {} : {compactedTo: activeCompactedTo}),
    });
    for (const message of messages) storage.chats.put(message);
    for (const checkpoint of checkpoints) storage.chatCompactions.put(checkpoint);
  });
}

async function readHistorySnapshot(
  workspaceId: string,
  chatId: number,
): Promise<ChatHistorySnapshot> {
  const stub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
  );
  return runInDurableObject(stub, async (instance) => {
    const storage = (instance as unknown as ChatHistoryStorageFixture).impl.storage;
    return {
      messages: [...storage.chats.list()]
        .filter((message) => message.chatId === chatId)
        .toSorted((left, right) => left.sequence - right.sequence),
      metadata: storage.chatMeta.get(chatId),
      checkpoints: [...storage.chatCompactions.list()]
        .filter((checkpoint) => checkpoint.chatId === chatId)
        .toSorted((left, right) => left.compactedTo - right.compactedTo),
    };
  });
}

async function rejectedError(call: PromiseLike<unknown>): Promise<CodedError> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new TypeError("Expected native RPC to reject with an Error.", {cause: error});
    }
    return error;
  }
  throw new Error("Expected native RPC to reject.");
}

describe("Cybernest Manager runtime", () => {
  it.each([
    { name: "missing Origin", origin: undefined },
    { name: "Origin null", origin: "null" },
    { name: "disallowed Origin", origin: TEST_DISALLOWED_ORIGIN },
  ])(
    "requires an exact allowed Origin ($name) even with a legacy Manager header and lease",
    async ({ origin }) => {
      const id = managerId();
      await seedExistingManagerProfile(id);
      const headers = new Headers({
        Upgrade: "websocket",
        ...privateManagerHeaders(id),
      });
      if (origin !== undefined) headers.set("Origin", origin);

      const response = await exports.default.fetch(
        new Request("https://workshop.invalid/api", {
          headers,
        }),
      );

      expect(response.status).not.toBe(101);
      expect(response.webSocket).toBeNull();
      await expect(managerProfile(id)).resolves.toMatchObject({ id });
    },
  );

  it.each(INVALID_CONNECTION_PROOF_CASES)(
    "rejects a $name proof without publishing or mutating a native root",
    async ({ overrides }) => {
      const id = managerId();
      const bootstrap = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
      const proofOverrides = overrides(Math.floor(Date.now() / 1_000));
      const proofSubject = proofOverrides.subject ?? id;

      try {
        await expectValidatorRejection(bootstrap.api.whoami());
        await expect(
          presentProductProof(bootstrap.api, await connectionProof(id, proofOverrides)),
        ).rejects.toThrow();
        await Promise.resolve();
        expect(bootstrap.socket?.readyState).toBe(WebSocket.CLOSED);
        await expect(bootstrap.api.whoami()).rejects.toThrow();
        await expect(managerProfile(id)).resolves.toBeNull();
        if (proofSubject !== id) await expect(managerProfile(proofSubject)).resolves.toBeNull();
      } finally {
        close(bootstrap);
      }
    },
  );

  it("returns the native proof result only after proof and releases its API separately from the socket", async () => {
    const deniedId = managerId();
    const denied = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });

    try {
      await expectValidatorRejection(denied.api.whoami());
      await expectValidatorRejection(denied.api.getServerConfig());
      await expectValidatorRejection(denied.api.ping());
      await expect(denied.api.getBlueprint("missing-before-proof")).resolves.toBeNull();
      await expect(denied.api.downloadBlueprint("missing-before-proof"))
        .rejects.toThrow("Blueprint not found.");
      await expect(
        presentProductProof(denied.api, await connectionProof(deniedId, { wrongSignature: true })),
      ).rejects.toThrow();
      await expect(managerProfile(deniedId)).resolves.toBeNull();
      expect(denied.socket?.readyState).toBe(WebSocket.CLOSED);
    } finally {
      close(denied);
    }

    const id = managerId();
    const bootstrap = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
    let result: PresentProofResult | undefined;
    let retainedApi: RpcStub<AuthenticatedApi> | undefined;

    try {
      const expectedConfig = await getServerConfig(env);
      result = await presentProductProof(bootstrap.api, await connectionProof(id));

      expectPresentProofResult(result);
      expect(result.serverConfig).toStrictEqual(expectedConfig);
      const authenticatedApi = result.authenticatedApi;
      await expect(authenticatedApi.whoami()).resolves.toMatchObject({ type: "user", id });
      await expect(managerProfile(id)).resolves.toMatchObject({ type: "user", id });
      await expect(authenticatedApi.listGadgets()).resolves.toEqual([]);
      await expect(authenticatedApi.defaultWorkspace("observe")).resolves.toBeNull();
      await expect(authenticatedApi.listGadgets()).resolves.toEqual([]);

      const workspaceId = await authenticatedApi.defaultWorkspace("prepare");
      expect(workspaceId).toEqual(expect.any(String));
      await expect(authenticatedApi.listGadgets()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: workspaceId, lifecycle: "unused" }),
        ]),
      );

      retainedApi = authenticatedApi.dup();
      disposeProofResult(result);
      result = undefined;
      expect(bootstrap.socket?.readyState).toBe(WebSocket.OPEN);
      await expect(retainedApi.whoami()).resolves.toMatchObject({ type: "user", id });
      retainedApi[Symbol.dispose]();
      retainedApi = undefined;
      expect(bootstrap.socket?.readyState).toBe(WebSocket.OPEN);

      await expectValidatorRejection(bootstrap.api.getServerConfig());
      await expectValidatorRejection(bootstrap.api.ping());
      await expect(bootstrap.api.getBlueprint("missing-after-proof")).resolves.toBeNull();
      await expect(bootstrap.api.downloadBlueprint("missing-after-proof"))
        .rejects.toThrow("Blueprint not found.");
    } finally {
      retainedApi?.[Symbol.dispose]();
      if (result !== undefined) disposeProofResult(result);
      bootstrap.api[Symbol.dispose]();
      bootstrap.socket?.close();
      if (bootstrap.closeAt) await waitForSocketClose(bootstrap.closeAt, 2_000);
    }
  });

  it("does not let a second valid proof switch the identity of one native connection", async () => {
    const managerA = managerId();
    const managerB = managerId();
    const bootstrap = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
    let rootA: RpcStub<AuthenticatedApi> | undefined;

    try {
      const proofResult = await presentProductProof(
        bootstrap.api,
        await connectionProof(managerA),
      );
      try {
        rootA = proofResult.authenticatedApi.dup();
      } finally {
        disposeProofResult(proofResult);
      }
      await expect(rootA.whoami()).resolves.toMatchObject({ id: managerA });

      await expect(
        presentProductProof(bootstrap.api, await connectionProof(managerB)),
      ).rejects.toThrow();
      await Promise.resolve();
      await expect(managerProfile(managerB)).resolves.toBeNull();

      if (bootstrap.socket?.readyState === WebSocket.OPEN) {
        await expect(rootA.whoami()).resolves.toMatchObject({ id: managerA });
      } else {
        expect(bootstrap.socket?.readyState).toBe(WebSocket.CLOSED);
        await expect(rootA.whoami()).rejects.toThrow();
      }
    } finally {
      rootA?.[Symbol.dispose]();
      close(bootstrap);
    }
  });

  it("does not expose AuthenticatedApi from the legacy header and lease without proof", async () => {
    const id = managerId();
    await seedExistingManagerProfile(id);
    const response = await exports.default.fetch(
      new Request("https://workshop.invalid/api", {
        headers: {
          Upgrade: "websocket",
          Origin: TEST_ALLOWED_ORIGIN,
          ...privateManagerHeaders(id),
        },
      }),
    );

    if (response.status === 101 && response.webSocket) {
      const socket = response.webSocket;
      socket.accept();
      const bootstrap = newWebSocketRpcSession<ProductBootstrapRootProbeApi>(socket);
      try {
        await expectValidatorRejection(bootstrap.whoami());
      } finally {
        bootstrap[Symbol.dispose]();
        socket.close();
      }
      return;
    }

    expect(response.status).not.toBe(101);
    expect(response.webSocket).toBeNull();
  });

  it("keeps public Blueprint and asset reads before proof without granting root", async () => {
    const id = managerId();
    const screenshotId = `cybernest-test-${crypto.randomUUID()}`;
    const screenshotKey = `${BLUEPRINT_SCREENSHOT_R2_PREFIX}${screenshotId}`;
    await exports.AdminSettings.getByName("").ensureBundledBlueprintsInstalled();
    await env.BLUEPRINT_CONTENT.put(screenshotKey, TEST_SCREENSHOT_BYTES, {
      httpMetadata: { contentType: "image/png" },
    });

    try {
      const session = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
      try {
        await expect(session.api.getBlueprint(TEST_BLUEPRINT_ID)).resolves.toMatchObject({
          id: TEST_BLUEPRINT_ID,
        });
        const archive = await session.api.downloadBlueprint(TEST_BLUEPRINT_ID);
        const archiveReader = archive.getReader();
        try {
          const firstChunk = await archiveReader.read();
          expect(firstChunk.done).toBe(false);
          expect(firstChunk.value).toBeInstanceOf(Uint8Array);
          expect(firstChunk.value!.byteLength).toBeGreaterThan(0);
        } finally {
          await archiveReader.cancel();
        }

        await expectValidatorRejection(session.api.whoami());
        await expect(managerProfile(id)).resolves.toBeNull();
      } finally {
        close(session);
      }

      const screenshot = await exports.default.fetch(
        new Request(`https://workshop.invalid${BLUEPRINT_SCREENSHOT_PATH_PREFIX}${screenshotId}`, {
          headers: { Origin: TEST_ALLOWED_ORIGIN },
        }),
      );
      expect(screenshot.status).toBe(200);
      expect(screenshot.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(TEST_SCREENSHOT_BYTES);

      const logoMethod = await exports.default.fetch(
        new Request(`https://workshop.invalid${SITE_LOGO_PATH}`, {
          method: "POST",
          headers: { Origin: TEST_ALLOWED_ORIGIN },
        }),
      );
      expect(logoMethod.status).toBe(405);
      expect(logoMethod.headers.get("Allow")).toBe("GET, HEAD");

      const clientErrorsGet = await exports.default.fetch(
        new Request("https://workshop.invalid/api/client-errors"),
      );
      expect(clientErrorsGet.status).toBe(405);
      const clientErrorsCrossOrigin = await exports.default.fetch(
        new Request("https://workshop.invalid/api/client-errors", {
          method: "POST",
          headers: {
            Origin: TEST_DISALLOWED_ORIGIN,
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(clientErrorsCrossOrigin.status).toBe(403);

      const batch = await exports.default.fetch(
        new Request("https://workshop.invalid/api", {
          method: "POST",
          headers: {
            Origin: TEST_ALLOWED_ORIGIN,
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(batch.ok).toBe(false);
      expect(batch.webSocket).toBeNull();

      const disallowedOrigin = await exports.default.fetch(
        new Request("https://workshop.invalid/api", {
          headers: { Upgrade: "websocket", Origin: TEST_DISALLOWED_ORIGIN },
        }),
      );
      expect(disallowedOrigin.status).not.toBe(101);
      expect(disallowedOrigin.webSocket).toBeNull();
      await expect(managerProfile(id)).resolves.toBeNull();
    } finally {
      await env.BLUEPRINT_CONTENT.delete(screenshotKey);
    }
  });

  it("keeps the native profile when directory sync fails and retries through the same DO", async () => {
    const id = managerId();
    const directory = exports.UserDirectoryDurableObject.getByName("");
    await createDirectoryFailureTrigger(id);

    try {
      await expect(runInDurableObject<UserDirectoryDurableObject, void>(
        directory,
        (instance) => instance.syncUser({ id, name: "Directory Failure Probe" }, 0),
      )).rejects.toThrow("synthetic directory sync failure");

      const session = await connectProductNative(id);
      try {
        await expect(session.api.whoami()).resolves.toMatchObject({ id });
        await expect(directory.searchUsers(id, [])).resolves.toEqual([]);
        const revisions = await directoryRevisions(id);
        expect(revisions.directoryRev).toBeLessThan(revisions.profileRev);
      } finally {
        close(session);
      }
    } finally {
      await dropDirectoryFailureTrigger(id);
    }

    const retry = await connectProductNative(id);
    try {
      await expect(retry.api.whoami()).resolves.toMatchObject({ id });
      await expect.poll(() => directory.searchUsers(id, [])).toEqual([{ id, name: "Manager" }]);
      const revisions = await directoryRevisions(id);
      expect(revisions.directoryRev).toBe(revisions.profileRev);
    } finally {
      close(retry);
    }
  });

  it("exposes the native AuthenticatedApi at the product private root", async () => {
    const id = managerId();
    await ensure(id);

    const session = await connectProductNative(id);
    try {
      await expect(session.api.listGadgets()).resolves.toEqual(expect.any(Array));
      const legacy = session.api as unknown as {
        listWorkspaces(): Promise<unknown>;
        createWorkspace(): Promise<unknown>;
      };
      await expectValidatorRejection(legacy.listWorkspaces());
      await expectValidatorRejection(legacy.createWorkspace());
    } finally {
      close(session);
    }
  });

  it("accepts a Core-compatible canonical UUID v7 Manager subject on its existing DO", async () => {
    const id = "01890f3e-7c00-7000-8000-000000000001";
    await seedExistingManagerProfile(id);

    const session = await connectProductNative(id);
    try {
      await expect(session.api.whoami()).resolves.toMatchObject({type: "user", id});
      await expect(managerProfile(id)).resolves.toMatchObject({type: "user", id});
    } finally {
      close(session);
    }
  });

  it("keeps native checkpoint pages intact while paging backward", async () => {
    const id = managerId();
    await ensure(id);

    const session = await connectProductNative(id);
    let workspace: RpcStub<Overseer> | undefined;
    try {
      workspace = await session.api.newGadget();
      const workspaceId = (await workspace.getMetadata()).id;
      const chatId = 41;
      await seedHistory(
        workspaceId,
        chatId,
        [1, 2, 3, 4].map((sequence) => historyMessage(chatId, sequence, `message-${sequence}`)),
        [
          historyCheckpoint(chatId, 2, "summary-before-2"),
          historyCheckpoint(chatId, 3, "summary-before-3"),
        ],
        3,
      );

      const current = await workspace.getChatHistory(chatId);
      expect(current.messages.map((message) => message.sequence)).toEqual([3, 4]);
      expect(current.compacted).toMatchObject({to: 3, summary: "summary-before-3"});

      const previous = await workspace.getChatHistory(chatId, current.compacted!.to);
      expect(previous.messages.map((message) => message.sequence)).toEqual([2]);
      expect(previous.compacted).toMatchObject({to: 2, summary: "summary-before-2"});

      const first = await workspace.getChatHistory(chatId, previous.compacted!.to);
      expect(first.messages.map((message) => message.sequence)).toEqual([1]);
      expect(first.compacted).toBeUndefined();
    } finally {
      workspace?.[Symbol.dispose]();
      close(session);
    }
  });

  it("rejects a 501-message checkpoint page over private native RPC without mutation", async () => {
    const id = managerId();
    await ensure(id);

    const session = await connectProductNative(id);
    let workspace: RpcStub<Overseer> | undefined;
    try {
      workspace = await session.api.newGadget();
      const workspaceId = (await workspace.getMetadata()).id;
      const chatId = 42;
      await seedHistory(
        workspaceId,
        chatId,
        Array.from({length: 501}, (_, index) =>
          historyMessage(chatId, index + 1, `message-${index + 1}`),
        ),
      );
      const before = await readHistorySnapshot(workspaceId, chatId);

      const error = await rejectedError(workspace.getChatHistory(chatId));
      expect(error.code).toBe(CHAT_HISTORY_ERROR_CODES.messageLimitExceeded);
      expect(getChatHistoryErrorCode(error)).toBe(CHAT_HISTORY_ERROR_CODES.messageLimitExceeded);
      await expect(readHistorySnapshot(workspaceId, chatId)).resolves.toEqual(before);
      workspace[Symbol.dispose]();
      workspace = undefined;
      await expect(session.api.whoami()).resolves.toMatchObject({type: "user", id});
    } finally {
      workspace?.[Symbol.dispose]();
      close(session);
    }
  }, 15_000);

  it("rejects an over-budget UTF-8 page over private native RPC without mutation", async () => {
    const id = managerId();
    await ensure(id);

    const session = await connectProductNative(id);
    let workspace: RpcStub<Overseer> | undefined;
    try {
      workspace = await session.api.newGadget();
      const workspaceId = (await workspace.getMetadata()).id;
      const chatId = 43;
      const chunk = "界".repeat(22_000);
      await seedHistory(
        workspaceId,
        chatId,
        Array.from({ length: 33 }, (_, index) => historyMessage(chatId, index + 1, chunk)),
      );
      const before = await readHistorySnapshot(workspaceId, chatId);

      const error = await rejectedError(workspace.getChatHistory(chatId));
      expect(error.code).toBe(CHAT_HISTORY_ERROR_CODES.textLimitExceeded);
      expect(getChatHistoryErrorCode(error)).toBe(CHAT_HISTORY_ERROR_CODES.textLimitExceeded);
      await expect(readHistorySnapshot(workspaceId, chatId)).resolves.toEqual(before);
      workspace[Symbol.dispose]();
      workspace = undefined;
      await expect(session.api.whoami()).resolves.toMatchObject({type: "user", id});
    } finally {
      workspace?.[Symbol.dispose]();
      close(session);
    }
  }, 15_000);

  it("rejects the 101st owned workspace and keeps the list bounded", async () => {
    const id = managerId();
    await ensure(id);
    const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(id));

    await runInDurableObject(user, async (instance) => {
      const owner = instance as unknown as {
        newGadget(id: string, title: string): Promise<void>;
        listGadgets(): Promise<unknown[]>;
      };
      for (let index = 0; index < 100; index += 1) {
        await owner.newGadget(`workspace-${index}-${crypto.randomUUID()}`, `Workspace ${index}`);
      }
      await expect(
        owner.newGadget(`workspace-over-limit-${crypto.randomUUID()}`, "Over limit"),
      ).rejects.toThrow("Workspace limit reached");
      await expect(owner.listGadgets()).resolves.toHaveLength(100);
    });
  });
  it("ensures one manager profile, isolates A/B state, and reconnects to A", async () => {
    const managerA = managerId();
    const managerB = managerId();

    await expect(managerProfile(managerA)).resolves.toBeNull();
    const sessionA = await connectProductNative(managerA);
    let gadgetId: string;
    try {
      await expect(sessionA.api.whoami()).resolves.toMatchObject({
        type: "user",
        id: managerA,
      });

      const workspace = await sessionA.api.newGadget();
      try {
        const metadata = await workspace.getMetadata();
        gadgetId = metadata.id;
      } finally {
        workspace[Symbol.dispose]();
      }

      await expect(waitForGadget(sessionA.api, gadgetId)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(sessionA);
    }

    await expect(managerProfile(managerB)).resolves.toBeNull();
    const sessionB = await connectProductNative(managerB);
    try {
      await expect(sessionB.api.whoami()).resolves.toMatchObject({
        type: "user",
        id: managerB,
      });
      await expect(sessionB.api.listGadgets()).resolves.not.toContainEqual(
        expect.objectContaining({ id: gadgetId! }),
      );
    } finally {
      close(sessionB);
    }

    const reconnectedA = await connectProductNative(managerA);
    try {
      await expect(reconnectedA.api.whoami()).resolves.toMatchObject({id: managerA});
      await expect(waitForGadget(reconnectedA.api, gadgetId!)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(reconnectedA);
    }
  });

  it("closes guest and authenticated native sockets at the accept-based one-hour deadline", async () => {
    const guestId = managerId();
    const manager = managerId();
    const guest = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
    const guestAcceptedAt = Date.now();
    const authenticated = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
    const authenticatedAcceptedAt = Date.now();
    const guestSocket = guest.socket;
    const authenticatedSocket = authenticated.socket;
    const guestCloseAt = guest.closeAt;
    const authenticatedCloseAt = authenticated.closeAt;
    if (!guestSocket || !authenticatedSocket || !guestCloseAt || !authenticatedCloseAt) {
      throw new TypeError("Expected both product WebSockets to be accepted.");
    }
    let root: RpcStub<AuthenticatedApi> | undefined;
    let workspace: RpcStub<Overseer> | undefined;

    try {
      await expectValidatorRejection(guest.api.whoami());
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      const proofResult = await presentProductProof(
        authenticated.api,
        await connectionProof(manager),
      );
      try {
        root = proofResult.authenticatedApi.dup();
      } finally {
        disposeProofResult(proofResult);
      }
      await expect(root.whoami()).resolves.toMatchObject({ id: manager });
      workspace = await root.newGadget();
      const metadata = await workspace.getMetadata();
      const firstAcceptAt = Math.min(guestAcceptedAt, authenticatedAcceptedAt);
      const untilPreDeadline =
        CONNECTION_DEADLINE_MS - 15_000 - (Date.now() - firstAcceptAt);
      if (untilPreDeadline > 0) {
        await new Promise((resolve) => setTimeout(resolve, untilPreDeadline));
      }

      expect(guestSocket.readyState).toBe(WebSocket.OPEN);
      expect(authenticatedSocket.readyState).toBe(WebSocket.OPEN);
      expect(Date.now() - firstAcceptAt).toBeGreaterThanOrEqual(CONNECTION_DEADLINE_MS - 20_000);
      const rootAtPreDeadline = await settleRpcWithin(root.whoami(), 2_000);
      if (rootAtPreDeadline.status !== "resolved") {
        throw new Error(`Pre-deadline whoami returned ${rootAtPreDeadline.status}.`);
      }
      expect(rootAtPreDeadline.value).toMatchObject({ id: manager });
      const workspaceAtPreDeadline = await settleRpcWithin(workspace.getMetadata(), 2_000);
      if (workspaceAtPreDeadline.status !== "resolved") {
        throw new Error(`Pre-deadline metadata returned ${workspaceAtPreDeadline.status}.`);
      }
      expect(workspaceAtPreDeadline.value).toMatchObject({ id: metadata.id });
      await expect(managerProfile(guestId)).resolves.toBeNull();

      const [guestClosedAt, authenticatedClosedAt] = await Promise.all([
        waitForSocketClose(guestCloseAt, 30_000),
        waitForSocketClose(authenticatedCloseAt, 30_000),
      ]);
      for (const [acceptedAt, closedAt] of [
        [guestAcceptedAt, guestClosedAt],
        [authenticatedAcceptedAt, authenticatedClosedAt],
      ]) {
        const observedLifetime = closedAt - acceptedAt;
        expect(observedLifetime).toBeGreaterThanOrEqual(CONNECTION_DEADLINE_MS - 15_000);
        expect(observedLifetime).toBeLessThanOrEqual(CONNECTION_DEADLINE_MS + 15_000);
      }

      expect(guestSocket.readyState).toBe(WebSocket.CLOSED);
      expect(authenticatedSocket.readyState).toBe(WebSocket.CLOSED);
      const [guestAfterClose, rootAfterClose, workspaceAfterClose] = await Promise.all([
        settleRpcWithin(guest.api.whoami(), 2_000),
        settleRpcWithin(root.whoami(), 2_000),
        settleRpcWithin(workspace.getMetadata(), 2_000),
      ]);
      expect(guestAfterClose.status).toBe("rejected");
      expect(rootAfterClose.status).toBe("rejected");
      expect(workspaceAfterClose.status).toBe("rejected");
      await expect(managerProfile(guestId)).resolves.toBeNull();
      await expect(managerProfile(manager)).resolves.toMatchObject({ id: manager });
    } finally {
      workspace?.[Symbol.dispose]();
      root?.[Symbol.dispose]();
      close(authenticated);
      close(guest);
    }
  }, CONNECTION_DEADLINE_MS + 60_000);

  it("cleans up the accept timer and publishes no root after an invalid proof", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const id = managerId();
    let bootstrap: Session<ProductBootstrapRootProbeApi> | undefined;
    try {
      bootstrap = await openProductBootstrap({ origin: TEST_ALLOWED_ORIGIN });
      const socket = bootstrap.socket;
      if (!socket) throw new TypeError("Expected an accepted product WebSocket.");
      const deadlineTimerIndex = setTimeoutSpy.mock.calls.findIndex(
        (call) => call[1] === CONNECTION_DEADLINE_MS,
      );
      expect(deadlineTimerIndex).toBeGreaterThanOrEqual(0);
      const deadlineTimer = setTimeoutSpy.mock.results[deadlineTimerIndex]?.value;

      await expect(presentProductProof(bootstrap.api, "not-a-jws")).rejects.toThrow();
      await Promise.resolve();
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineTimer);
      await expect(managerProfile(id)).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(CONNECTION_DEADLINE_MS);
      await expect(managerProfile(id)).resolves.toBeNull();
    } finally {
      if (bootstrap !== undefined) close(bootstrap);
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a Manager workspace owner-only and blocks share creation", async () => {
    const ownerId = managerId();
    const otherId = managerId();
    const shareRecipientId = managerId();
    await ensure(ownerId);
    await ensure(otherId);
    await ensure(shareRecipientId);

    const ownerSession = await connectProductNative(ownerId);
    let workspaceId: string | undefined;
    try {
      using workspace = await ownerSession.api.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
    } finally {
      close(ownerSession);
    }

    const ownerNotifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseerStub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId!),
    );
    try {
      const ownerOverseer = await overseerStub.open(
          exports.UserDurableObject.idFromName(ownerId).toString(),
          ownerId,
          ownerNotifyClosed,
        );
      try {
        await expect(ownerOverseer.addCollaborator(otherId, "use")).rejects.toThrow(
          "This Manager runtime is private and cannot be shared.",
        );
        await expect(ownerOverseer.createShareLink("use")).rejects.toThrow(
          "This Manager runtime is private and cannot be shared.",
        );
        await expect(ownerOverseer.newShareLinkKey("missing-link")).rejects.toThrow(
          "This Manager runtime is private and cannot be shared.",
        );
        await expect(ownerOverseer.removeCollaborator(otherId, ["keep-user"])).rejects.toThrow(
          "A private Manager runtime cannot keep shared users.",
        );
        await expect(ownerOverseer.revokeShareLink("missing-link", ["keep-user"])).rejects.toThrow(
          "A private Manager runtime cannot keep shared users.",
        );

        // Seed pre-private-mode sharing state through the real SharingManager. Product RPCs above
        // remain closed; this direct fixture represents records persisted by an older OS pin.
        const legacyShare = await runInDurableObject(overseerStub, async (instance) => {
          const sharing = await (
            instance as unknown as {
            impl: {getSharingManager(): Promise<LegacySharingFixture>};
            }
          ).impl.getSharingManager();
          const caller = {profileId: ownerId, isOwner: true};
          sharing.addCollaborator({
            caller,
            profile: {type: "user", id: otherId, name: "Legacy collaborator"},
            role: "use",
            note: "legacy",
          });
          return sharing.createShareLink({caller, role: "use", note: "legacy"});
        });

        await expect(ownerOverseer.listCollaborators()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({profile: expect.objectContaining({id: otherId})}),
          ]),
        );
        await expect(ownerOverseer.previewRemoveCollaborator(otherId)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({profile: expect.objectContaining({id: otherId})}),
          ]),
        );
        await expect(ownerOverseer.listShareLinks()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({linkId: legacyShare.linkId, note: "legacy"}),
          ]),
        );
        await expect(ownerOverseer.previewRevokeShareLink(legacyShare.linkId)).resolves.toEqual([]);
        await ownerOverseer.updateShareLink(legacyShare.linkId, "legacy updated");
        await expect(ownerOverseer.listShareLinks()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({linkId: legacyShare.linkId, note: "legacy updated"}),
          ]),
        );

        const collaboratorNotifyClosed = new NativeRpcStub<() => void>(() => {});
        try {
          await expect(
            overseerStub.open(
            exports.UserDurableObject.idFromName(otherId).toString(),
            otherId,
            collaboratorNotifyClosed,
            ),
          ).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
        } finally {
          collaboratorNotifyClosed[Symbol.dispose]();
        }

        const shareNotifyClosed = new NativeRpcStub<() => void>(() => {});
        try {
          await expect(
            overseerStub.open(
            exports.UserDurableObject.idFromName(shareRecipientId).toString(),
            shareRecipientId,
            shareNotifyClosed,
            legacyShare.key,
            ),
          ).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
        } finally {
          shareNotifyClosed[Symbol.dispose]();
        }
        await expect(
          runInDurableObject(overseerStub, async (instance) => {
            const sharing = await (
              instance as unknown as {
            impl: {getSharingManager(): Promise<LegacySharingFixture>};
              }
            ).impl.getSharingManager();
          return sharing.isCollaborator(shareRecipientId);
          }),
        ).resolves.toBe(false);

        await expect(ownerOverseer.revokeShareLink(legacyShare.linkId, [])).resolves.toEqual([]);
        await expect(ownerOverseer.removeCollaborator(otherId, [])).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({profile: expect.objectContaining({id: otherId})}),
          ]),
        );
      } finally {
        ownerOverseer[Symbol.dispose]();
      }
    } finally {
      ownerNotifyClosed[Symbol.dispose]();
    }

    // Removing a legacy collaborator intentionally restarts the workspace after the response is
    // delivered. Observe that reset before making further assertions against the same DO so the
    // test cannot race the revocation timer.
    await expect(
      runInDurableObject(overseerStub, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }),
    ).rejects.toMatchObject({ durableObjectReset: true });
    overseerStub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId!),
    );

    const externalGateway = (
      exports as unknown as {
      ExternalMessageGateway: (input: { props: { source: string } }) => {
        submitExternalMessage(input: {
          callerEmail: string;
          gadgetKey: string;
          chatKey: string;
          messageKey: string;
          gadgetTitle: string;
          prompt: string;
          chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
        }): Promise<{ accepted: boolean; message?: string }>;
      };
      }
    ).ExternalMessageGateway({ props: { source: "private-test" } });
    const responseTarget = new NativeRpcStub<ChatGatewayRpcTarget>({
      onGadgetResponse: async () => {},
    });
    const externalEmail = "external@example.test";
    const externalWorkspace = exports.OverseerDurableObject.getByName(
      "private-test:external-gadget",
    );
    const existingStateBefore = await runInDurableObject(overseerStub, async (instance) => {
      const storage = (instance as unknown as WorkspaceStorageFixture).impl.storage;
      return {
        chats: [...storage.chatMeta.list()].length,
        externalChats: [...storage.externalChats.list()].length,
      };
    });
    try {
      await expect(
        externalGateway.submitExternalMessage({
        callerEmail: externalEmail,
        gadgetKey: "external-gadget",
        chatKey: "external-chat",
        messageKey: "external-message",
        gadgetTitle: "External",
        prompt: "hello",
        chatGatewayRpcTarget: responseTarget,
        }),
      ).resolves.toMatchObject({ accepted: false });

      await expect(
        overseerStub.receiveExternalMessage({
        callerEmail: externalEmail,
        externalChatKey: "private-test:existing-chat",
        idempotencyKey: "private-test:existing-message",
        prompt: "hello existing workspace",
        chatGatewayRpcTarget: responseTarget,
        title: "External",
        }),
      ).resolves.toMatchObject({ accepted: false });

      await expect(
        exports.UserDurableObject.get(
          exports.UserDurableObject.idFromName(externalEmail),
        ).whoamiIfExists(),
      ).resolves.toBeNull();

      await expect(
        runInDurableObject(externalWorkspace, async (instance) => {
        const storage = (instance as unknown as WorkspaceStorageFixture).impl.storage;
        return {
          ownerId: storage.ownerId.get(),
          chats: [...storage.chatMeta.list()].length,
          externalChats: [...storage.externalChats.list()].length,
        };
        }),
      ).resolves.toEqual({ ownerId: undefined, chats: 0, externalChats: 0 });

      await expect(
        runInDurableObject(overseerStub, async (instance) => {
        const storage = (instance as unknown as WorkspaceStorageFixture).impl.storage;
        return {
          chats: [...storage.chatMeta.list()].length,
          externalChats: [...storage.externalChats.list()].length,
        };
        }),
      ).resolves.toEqual(existingStateBefore);
    } finally {
      responseTarget[Symbol.dispose]();
    }
  });
});
