import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from "capnweb";
import { importJWK, SignJWT, type JWK } from "jose";
import {
  type AuthenticatedApi,
  type CybernestConnectionBootstrapApi,
} from "@gadgets/workshop-shared/api";
import { describe, expect, inject, it } from "vitest";
import type { GadgetRecord, UserStorage } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";

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
const RESPONSE_WAIT_MS = 2_000;
const ORIGINAL_GADGET_LIST = Symbol.for("cybernest.s2.original-gadget-list");
type WorkspaceStub = Awaited<ReturnType<AuthenticatedApi["newGadget"]>>;

type Session<T extends RpcTarget = AuthenticatedApi> = {
  api: RpcStub<T>;
  bootstrapApi?: RpcStub<CybernestConnectionBootstrapApi>;
  socket: WebSocket;
};

type RpcOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timeout" };

const managerId = (): string => crypto.randomUUID();
type PresentProofResult = Awaited<
  ReturnType<RpcStub<CybernestConnectionBootstrapApi>["presentProof"]>
>;

function isPrivateEs256Jwk(value: unknown): value is JWK {
  if (typeof value !== "object" || value === null) return false;
  return (
    "kty" in value &&
    value.kty === "EC" &&
    "crv" in value &&
    value.crv === "P-256" &&
    "x" in value &&
    typeof value.x === "string" &&
    "y" in value &&
    typeof value.y === "string" &&
    "d" in value &&
    typeof value.d === "string"
  );
}

async function connectionProof(id: string): Promise<string> {
  const jwk: unknown = JSON.parse(inject("cybernestOsTestPrivateJwk"));
  if (!isPrivateEs256Jwk(jwk)) throw new TypeError("Expected the synthetic ES256 test key.");
  const privateKey = await importJWK(jwk, "ES256");
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    purpose: "os_connection",
    environment: TEST_PROOF_ENVIRONMENT,
    deployment: TEST_PROOF_DEPLOYMENT,
  })
    .setProtectedHeader({ alg: "ES256", typ: "cybernest-os-connection+jwt" })
    .setIssuer(TEST_PROOF_ISSUER)
    .setAudience(TEST_PROOF_AUDIENCE)
    .setSubject(id)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(privateKey);
}

async function openBootstrap(): Promise<Session<CybernestConnectionBootstrapApi>> {
  const response = await exports.default.fetch(
    new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        Origin: TEST_ALLOWED_ORIGIN,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a native Worker WebSocket.");
  socket.accept();
  return {
    socket,
    api: newWebSocketRpcSession<CybernestConnectionBootstrapApi>(socket),
  };
}

async function connectNative(id: string): Promise<Session> {
  const bootstrap = await openBootstrap();
  try {
    const api = await presentProductApi(bootstrap.api, await connectionProof(id));
    return { api, bootstrapApi: bootstrap.api, socket: bootstrap.socket };
  } catch (error) {
    bootstrap.api[Symbol.dispose]();
    bootstrap.socket.close();
    throw error;
  }
}

function close<T extends RpcTarget>(session: Session<T>): void {
  session.api[Symbol.dispose]();
  session.bootstrapApi?.[Symbol.dispose]();
  session.socket.close();
}

async function presentProductProof(
  bootstrapApi: RpcStub<CybernestConnectionBootstrapApi>,
  proof: string,
): Promise<PresentProofResult> {
  return await bootstrapApi.presentProof(proof);
}

async function presentProductApi<T extends CybernestConnectionBootstrapApi>(
  bootstrapApi: RpcStub<T>,
  proof: string,
): Promise<RpcStub<AuthenticatedApi>> {
  const result = await presentProductProof(bootstrapApi, proof);
  try {
    return result.authenticatedApi.dup();
  } finally {
    result[Symbol.dispose]();
  }
}

function userStorage(instance: UserDurableObject): Pick<UserStorage, "gadgets"> {
  const storage: unknown = Reflect.get(instance, "storage");
  if (typeof storage !== "object" || storage === null || !("gadgets" in storage)) {
    throw new TypeError("Expected native User DO storage.");
  }
  const gadgets = storage.gadgets;
  if (
    typeof gadgets !== "object" ||
    gadgets === null ||
    !("list" in gadgets) ||
    typeof gadgets.list !== "function" ||
    !("put" in gadgets) ||
    typeof gadgets.put !== "function"
  ) {
    throw new TypeError("Expected native User DO gadget metadata storage.");
  }
  return storage;
}

function userStub(id: string) {
  return exports.UserDurableObject.get(exports.UserDurableObject.idFromName(id));
}

async function readRecords(id: string): Promise<GadgetRecord[]> {
  return runInDurableObject<UserDurableObject, GadgetRecord[]>(userStub(id), (instance) => [
    ...userStorage(instance).gadgets.list(),
  ]);
}

async function seedRecords(id: string, records: GadgetRecord[]): Promise<void> {
  await runInDurableObject<UserDurableObject, void>(userStub(id), (instance) => {
    const gadgets = userStorage(instance).gadgets;
    for (const record of records) gadgets.put(record);
  });
}

async function deleteWorkspaceRecordFromNativeUser(
  managerIdentifier: string,
  workspaceIdentifier: string,
): Promise<void> {
  await runInDurableObject<UserDurableObject, void>(userStub(managerIdentifier), (instance) =>
    instance.deleteGadget(workspaceIdentifier),
  );
}

async function injectGadgetMetadataReadFailure(id: string): Promise<void> {
  await runInDurableObject<UserDurableObject, void>(userStub(id), (instance) => {
    const gadgets = userStorage(instance).gadgets;
    Reflect.set(gadgets, ORIGINAL_GADGET_LIST, gadgets.list.bind(gadgets));
    Reflect.set(gadgets, "list", () => {
      throw new Error("synthetic default-workspace metadata read failure");
    });
  });
}

async function restoreGadgetMetadataRead(id: string): Promise<void> {
  await runInDurableObject<UserDurableObject, void>(userStub(id), (instance) => {
    const gadgets = userStorage(instance).gadgets;
    const original = Reflect.get(gadgets, ORIGINAL_GADGET_LIST);
    if (typeof original !== "function") {
      throw new Error("Could not restore the native User DO metadata reader.");
    }
    Reflect.set(gadgets, "list", original);
    Reflect.deleteProperty(gadgets, ORIGINAL_GADGET_LIST);
  });
}

function workspaceId(): string {
  return exports.OverseerDurableObject.newUniqueId().toString();
}

function ownedRecord(id: string): GadgetRecord {
  const now = new Date(1);
  return {
    id,
    title: "Existing owned workspace",
    created: now,
    lastActive: now,
    lifecycle: "unused",
  };
}

function provisionalRecord(id: string): GadgetRecord {
  return {
    id,
    title: "Provisional workspace",
    created: new Date(1),
  };
}

function sharedRecord(id: string, ownerId: string): GadgetRecord {
  const now = new Date(1);
  return {
    id,
    title: "Shared workspace",
    owner: { type: "user", id: ownerId, name: "Another Manager" },
    created: now,
    lastActive: now,
    lifecycle: "active",
  };
}

function ownedFullRecords(records: GadgetRecord[]): GadgetRecord[] {
  return records.filter((record) => record.owner === undefined && record.lastActive !== undefined);
}

async function settleRpcWithin<T>(call: Promise<T>, timeoutMs: number): Promise<RpcOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call.then(
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

async function waitForOwnedFullRecords(id: string, expectedCount: number): Promise<GadgetRecord[]> {
  const deadline = Date.now() + RESPONSE_WAIT_MS;
  let records: GadgetRecord[] = [];
  while (Date.now() < deadline) {
    records = ownedFullRecords(await readRecords(id));
    if (records.length === expectedCount) return records;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Native User DO did not reach the expected workspace record count.");
}

function socketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    socket.addEventListener("close", finish, { once: true });
    if (socket.readyState === WebSocket.CLOSED) finish();
  });
}

function sendOpaqueWebSocketFrame(target: WebSocket, data: unknown): void {
  if (typeof data === "string" || data instanceof ArrayBuffer) {
    target.send(data);
    return;
  }
  throw new TypeError("Expected an opaque string or ArrayBuffer WebSocket frame.");
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("atomic default workspace on the native OS Worker", () => {
  it("creates one workspace for parallel prepare and preserves explicit multi-create", async () => {
    const id = managerId();
    expect(await readRecords(id)).toEqual([]);

    const session = await connectNative(id);
    const workspaces: WorkspaceStub[] = [];
    try {
      // Account/profile bootstrap and read-only observation do not create a workspace.
      expect(await readRecords(id)).toEqual([]);
      await expect(session.api.defaultWorkspace("observe")).resolves.toBeNull();
      expect(await readRecords(id)).toEqual([]);

      const results = await Promise.all(
        Array.from({ length: 8 }, () => session.api.defaultWorkspace("prepare")),
      );
      expect(results).toHaveLength(8);
      expect(results.every((value) => typeof value === "string")).toBe(true);
      const ids = results.filter((value): value is string => typeof value === "string");
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(1);
      const [defaultId] = ids;
      if (defaultId === undefined) throw new Error("Expected a prepared workspace ID.");

      const recordsAfterPrepare = await readRecords(id);
      expect(ownedFullRecords(recordsAfterPrepare)).toHaveLength(1);
      expect(ownedFullRecords(recordsAfterPrepare)[0]?.id).toBe(defaultId);

      const opened = await session.api.openGadget(defaultId);
      try {
        await expect(opened.getMetadata()).resolves.toMatchObject({ id: defaultId });
      } finally {
        opened[Symbol.dispose]();
      }

      for (let index = 0; index < 2; index += 1) {
        workspaces.push(await session.api.newGadget());
      }
      const ordinaryIds = await Promise.all(
        workspaces.map(async (workspace) => (await workspace.getMetadata()).id),
      );
      expect(new Set(ordinaryIds).size).toBe(2);
      expect(ordinaryIds).not.toContain(defaultId);
      expect(ownedFullRecords(await readRecords(id))).toHaveLength(3);
    } finally {
      for (const workspace of workspaces) workspace[Symbol.dispose]();
      try {
        await expect(session.api.whoami()).resolves.toMatchObject({ id });
      } finally {
        close(session);
      }
    }
  });

  it("reuses the one existing fully-created owned workspace for prepare and observe", async () => {
    const id = managerId();
    const session = await connectNative(id);
    let existing: WorkspaceStub | undefined;
    let reopened: WorkspaceStub | undefined;
    try {
      existing = await session.api.newGadget();
      const existingId = (await existing.getMetadata()).id;
      const before = await readRecords(id);

      await expect(session.api.defaultWorkspace("prepare")).resolves.toBe(existingId);
      await expect(session.api.defaultWorkspace("observe")).resolves.toBe(existingId);
      await expect(readRecords(id)).resolves.toEqual(before);

      reopened = await session.api.openGadget(existingId);
      await expect(reopened.getMetadata()).resolves.toMatchObject({ id: existingId });
    } finally {
      reopened?.[Symbol.dispose]();
      existing?.[Symbol.dispose]();
      try {
        await expect(session.api.whoami()).resolves.toMatchObject({ id });
      } finally {
        close(session);
      }
    }
  });

  it("does not choose a shared record and creates an owned one only on prepare", async () => {
    const id = managerId();
    const sharedId = workspaceId();
    const shared = sharedRecord(sharedId, managerId());
    const session = await connectNative(id);
    try {
      await seedRecords(id, [shared]);
      const beforeObserve = await readRecords(id);

      await expect(session.api.defaultWorkspace("observe")).resolves.toBeNull();
      await expect(readRecords(id)).resolves.toEqual(beforeObserve);

      const prepared = await session.api.defaultWorkspace("prepare");
      expect(typeof prepared).toBe("string");
      if (typeof prepared !== "string") throw new Error("Expected a prepared workspace ID.");
      expect(prepared).not.toBe(sharedId);

      const afterPrepare = await readRecords(id);
      expect(afterPrepare).toContainEqual(shared);
      expect(ownedFullRecords(afterPrepare)).toEqual([expect.objectContaining({ id: prepared })]);
      await expect(session.api.defaultWorkspace("observe")).resolves.toBe(prepared);
    } finally {
      close(session);
    }
  });

  type UnsafeMetadataCase = {
    name: string;
    records: (this: void, first: string, second: string) => GadgetRecord[];
  };
  const unsafeMetadataCases: UnsafeMetadataCase[] = [
    {
      name: "multiple owned candidates",
      records: (first: string, second: string) => [ownedRecord(first), ownedRecord(second)],
    },
    {
      name: "an owned provisional record",
      records: (first: string, _second: string) => [provisionalRecord(first)],
    },
    {
      name: "inconsistent native metadata",
      records: (first: string, _second: string) => {
        const record = ownedRecord(first);
        Reflect.set(record, "created", "not-a-native-date");
        return [record];
      },
    },
    {
      name: "an invalid native workspace ID",
      records: () => [ownedRecord("not-a-native-workspace-id")],
    },
  ];

  it.each(unsafeMetadataCases)(
    "keeps $name unknown without adding a workspace",
    async ({ records: makeRecords }) => {
      const id = managerId();
      const session = await connectNative(id);
      try {
        const initial = makeRecords(workspaceId(), workspaceId());
        if (initial[0]?.id === "not-a-native-workspace-id") {
          expect(() => exports.OverseerDurableObject.idFromString(initial[0].id)).toThrow(
            TypeError,
          );
        }
        await seedRecords(id, initial);
        const before = await readRecords(id);

        await expect(session.api.defaultWorkspace("observe")).resolves.toBeNull();
        await expect(session.api.defaultWorkspace("prepare")).resolves.toBeNull();
        await expect(readRecords(id)).resolves.toEqual(before);
      } finally {
        close(session);
      }
    },
  );

  it("returns unknown without creating when native metadata reading fails", async () => {
    const id = managerId();
    const session = await connectNative(id);
    let injected = false;
    try {
      await injectGadgetMetadataReadFailure(id);
      injected = true;
      await expect(session.api.defaultWorkspace("prepare")).resolves.toBeNull();
      await expect(session.api.defaultWorkspace("observe")).resolves.toBeNull();
    } finally {
      try {
        if (injected) await restoreGadgetMetadataRead(id);
      } finally {
        close(session);
      }
    }
    await expect(readRecords(id)).resolves.toEqual([]);
  });

  it("drops the native prepare response after its workspace commit", async () => {
    const id = managerId();
    expect(await readRecords(id)).toEqual([]);
    const upstreamResponse = await exports.default.fetch(
      new Request("https://workshop.invalid/api", {
        headers: {
          Upgrade: "websocket",
          Origin: TEST_ALLOWED_ORIGIN,
        },
      }),
    );
    expect(upstreamResponse.status).toBe(101);
    const upstreamSocket = upstreamResponse.webSocket;
    if (!upstreamSocket) throw new TypeError("Expected the native Worker WebSocket.");

    const relayPair = new WebSocketPair();
    const relaySocket = relayPair[0];
    const relayResponse = new Response(null, { status: 101, webSocket: relayPair[1] });
    const clientSocket = relayResponse.webSocket;
    if (!clientSocket) throw new TypeError("Expected the native relay WebSocket.");

    upstreamSocket.binaryType = "arraybuffer";
    relaySocket.binaryType = "arraybuffer";
    clientSocket.binaryType = "arraybuffer";
    let holdDownlink = false;
    let heldDownlinkCount = 0;
    const responseHeld = deferred();
    const forwardClientFrame = (event: MessageEvent): void => {
      sendOpaqueWebSocketFrame(upstreamSocket, event.data);
    };
    const forwardServerFrame = (event: MessageEvent): void => {
      if (holdDownlink) {
        heldDownlinkCount += 1;
        responseHeld.resolve();
      } else {
        sendOpaqueWebSocketFrame(relaySocket, event.data);
      }
    };
    const closeUpstream = (): void => {
      if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.close();
    };
    const closeRelay = (): void => {
      if (relaySocket.readyState === WebSocket.OPEN) relaySocket.close();
    };

    relaySocket.addEventListener("message", forwardClientFrame);
    upstreamSocket.addEventListener("message", forwardServerFrame);
    relaySocket.addEventListener("close", closeUpstream, { once: true });
    upstreamSocket.addEventListener("close", closeRelay, { once: true });
    upstreamSocket.accept();
    relaySocket.accept();
    clientSocket.accept();

    const bootstrapApi = newWebSocketRpcSession<CybernestConnectionBootstrapApi>(clientSocket);
    let api: RpcStub<AuthenticatedApi> | undefined;
    let recordsBeforeClose: GadgetRecord[] | undefined;
    let clientSocketCloseConfirmed = false;
    let bootstrapDisposed = false;

    try {
      api = await presentProductApi(
        bootstrapApi,
        await connectionProof(id),
      );
      // The proof response completed before the only pending request; hold opaque downstream
      // frames from this point without decoding or modifying the native RPC protocol.
      holdDownlink = true;
      const pendingPrepare = api.defaultWorkspace("prepare");
      const pendingPrepareOutcome: Promise<RpcOutcome<string | null>> = pendingPrepare.then(
        (value): RpcOutcome<string | null> => ({ status: "resolved", value }),
        (reason: unknown): RpcOutcome<string | null> => ({ status: "rejected", reason }),
      );

      const heldOutcome = await settleRpcWithin(responseHeld.promise, RESPONSE_WAIT_MS);
      expect(heldOutcome.status).toBe("resolved");
      expect(heldDownlinkCount).toBeGreaterThan(0);
      expect(await settleRpcWithin(pendingPrepareOutcome, 100)).toEqual({ status: "timeout" });
      const committedRecords = await waitForOwnedFullRecords(id, 1);
      expect(committedRecords).toHaveLength(1);
      recordsBeforeClose = await readRecords(id);
      expect(recordsBeforeClose).toHaveLength(1);
      expect(recordsBeforeClose[0]?.id).toBe(committedRecords[0]?.id);

      const closed = socketClosed(clientSocket);
      bootstrapDisposed = true;
      bootstrapApi[Symbol.dispose]();
      const closeOutcome = await settleRpcWithin(closed, RESPONSE_WAIT_MS);
      clientSocketCloseConfirmed = closeOutcome.status === "resolved";
      expect(closeOutcome.status).toBe("resolved");
      const clientResult = await settleRpcWithin(pendingPrepareOutcome, RESPONSE_WAIT_MS);
      expect(clientResult.status).toBe("resolved");
      if (clientResult.status !== "resolved") {
        throw new Error("Native prepare did not settle after the client socket closed.");
      }
      expect(clientResult.value.status).toBe("rejected");
    } finally {
      const finalClientClose = clientSocketCloseConfirmed ? undefined : socketClosed(clientSocket);
      try {
        api?.[Symbol.dispose]();
        if (!bootstrapDisposed) {
          bootstrapDisposed = true;
          bootstrapApi[Symbol.dispose]();
        }
      } finally {
        try {
          const relayClosed = socketClosed(relaySocket);
          const upstreamClosed = socketClosed(upstreamSocket);
          closeRelay();
          closeUpstream();
          const [relayCloseOutcome, upstreamCloseOutcome] = await Promise.all([
            settleRpcWithin(relayClosed, RESPONSE_WAIT_MS),
            settleRpcWithin(upstreamClosed, RESPONSE_WAIT_MS),
          ]);
          expect(relayCloseOutcome.status).toBe("resolved");
          expect(upstreamCloseOutcome.status).toBe("resolved");
          if (finalClientClose) {
            const clientCloseOutcome = await settleRpcWithin(finalClientClose, RESPONSE_WAIT_MS);
            clientSocketCloseConfirmed = clientCloseOutcome.status === "resolved";
            expect(clientCloseOutcome.status).toBe("resolved");
          }
        } finally {
          relaySocket.removeEventListener("message", forwardClientFrame);
          upstreamSocket.removeEventListener("message", forwardServerFrame);
          relaySocket.removeEventListener("close", closeUpstream);
          upstreamSocket.removeEventListener("close", closeRelay);
        }
      }
    }

    if (!recordsBeforeClose) throw new Error("Native prepare did not expose committed metadata.");
    await expect(readRecords(id)).resolves.toEqual(recordsBeforeClose);
    const recovered = await connectNative(id);
    try {
      const observed = await recovered.api.defaultWorkspace("observe");
      if (observed === null)
        throw new Error("Expected the committed workspace to remain observable.");
      expect(recordsBeforeClose[0]?.id).toBe(observed);
      await expect(readRecords(id)).resolves.toEqual(recordsBeforeClose);

      await deleteWorkspaceRecordFromNativeUser(id, observed);
      await expect(readRecords(id)).resolves.toEqual([]);
      await expect(recovered.api.defaultWorkspace("observe")).resolves.toBeNull();
      await expect(readRecords(id)).resolves.toEqual([]);
    } finally {
      close(recovered);
    }
  }, 30_000);
});
