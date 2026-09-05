import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub, type RpcTarget } from "capnweb";
import {
  CHAT_HISTORY_ERROR_CODES,
  getChatHistoryErrorCode,
  type AiChatMessage,
  type AiChatMetadata,
  type AuthenticatedApi,
  type GadgetMetadataWithTimestamps,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import { describe, expect, it } from "vitest";
import type { CompactionCheckpoint } from "../src/agent";

type Session<T extends RpcTarget = AuthenticatedApi> = {
  api: RpcStub<T>;
  socket?: WebSocket;
};

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

async function managerRequest(
    path: string, method: "GET" | "POST", id?: string): Promise<Response> {
  const headers = id === undefined ? undefined : managerHeaders(id);
  return exports.default.fetch(new Request(`https://workshop.invalid${path}`, {method, headers}));
}

async function ensure(id: string): Promise<void> {
  const response = await managerRequest("/_cybernest/manager", "POST", id);
  expect(response.status).toBe(204);
}

async function read(id: string): Promise<Response> {
  return managerRequest("/_cybernest/manager", "GET", id);
}

async function connectProductNative<T extends RpcTarget = AuthenticatedApi>(
    id: string): Promise<Session<T>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {
      Upgrade: "websocket",
      ...privateManagerHeaders(id),
    },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return {
    socket,
    api: newWebSocketRpcSession<T>(socket),
  };
}

async function connectNative(id: string): Promise<Session> {
  const native = (env as unknown as {
    MANAGER_NATIVE_REGRESSION: {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  }).MANAGER_NATIVE_REGRESSION;
  const response = await native.fetch("https://workshop.invalid/api", {
    headers: {
      Upgrade: "websocket",
      ...managerHeaders(id),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return {socket, api: newWebSocketRpcSession<AuthenticatedApi>(socket)};
}

function close<T extends RpcTarget>(session: Session<T>): void {
  session.api[Symbol.dispose]();
  session.socket?.close();
}

async function expectValidatorRejection(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toThrow(
      /^(?:capnweb-validate: refused |'[^']+' is not a function\.$)/u,
  );
}

async function waitForGadget(
    api: RpcStub<AuthenticatedApi>, id: string): Promise<GadgetMetadataWithTimestamps> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const gadget = (await api.listGadgets()).find(item => item.id === id);
    if (gadget) return gadget;
    await new Promise(resolve => setTimeout(resolve, 25));
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
    chatId: number, compactedTo: number, summary: string): CompactionCheckpoint {
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
    workspaceId: string, chatId: number): Promise<ChatHistorySnapshot> {
  const stub = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
  );
  return runInDurableObject(stub, async (instance) => {
    const storage = (instance as unknown as ChatHistoryStorageFixture).impl.storage;
    return {
      messages: [...storage.chats.list()]
        .filter(message => message.chatId === chatId)
        .toSorted((left, right) => left.sequence - right.sequence),
      metadata: storage.chatMeta.get(chatId),
      checkpoints: [...storage.chatCompactions.list()]
        .filter(checkpoint => checkpoint.chatId === chatId)
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
  it("exposes the native AuthenticatedApi at the product private root", async () => {
    const id = managerId();
    await ensure(id);

    const session = await connectProductNative(id);
    try {
      await expect(session.api.listGadgets()).resolves.toEqual(expect.any(Array));
      const legacy = session.api as unknown as {
        listWorkspaces(): Promise<unknown>;
        createWorkspace(): Promise<unknown>;
        organizeChat(): Promise<unknown>;
        saveConversation(): Promise<unknown>;
      };
      await expectValidatorRejection(legacy.listWorkspaces());
      await expectValidatorRejection(legacy.createWorkspace());
      await expectValidatorRejection(legacy.organizeChat());
      await expectValidatorRejection(legacy.saveConversation());
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
        [1, 2, 3, 4].map(sequence => historyMessage(chatId, sequence, `message-${sequence}`)),
        [
          historyCheckpoint(chatId, 2, "summary-before-2"),
          historyCheckpoint(chatId, 3, "summary-before-3"),
        ],
        3,
      );

      const current = await workspace.getChatHistory(chatId);
      expect(current.messages.map(message => message.sequence)).toEqual([3, 4]);
      expect(current.compacted).toMatchObject({to: 3, summary: "summary-before-3"});

      const previous = await workspace.getChatHistory(chatId, current.compacted!.to);
      expect(previous.messages.map(message => message.sequence)).toEqual([2]);
      expect(previous.compacted).toMatchObject({to: 2, summary: "summary-before-2"});

      const first = await workspace.getChatHistory(chatId, previous.compacted!.to);
      expect(first.messages.map(message => message.sequence)).toEqual([1]);
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
          historyMessage(chatId, index + 1, `message-${index + 1}`)),
      );
      const before = await readHistorySnapshot(workspaceId, chatId);

      const error = await rejectedError(workspace.getChatHistory(chatId));
      expect(error.code).toBe(CHAT_HISTORY_ERROR_CODES.messageLimitExceeded);
      expect(getChatHistoryErrorCode(error)).toBe(
        CHAT_HISTORY_ERROR_CODES.messageLimitExceeded,
      );
      await expect(readHistorySnapshot(workspaceId, chatId)).resolves.toEqual(before);
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
        Array.from({length: 33}, (_, index) =>
          historyMessage(chatId, index + 1, chunk)),
      );
      const before = await readHistorySnapshot(workspaceId, chatId);

      const error = await rejectedError(workspace.getChatHistory(chatId));
      expect(error.code).toBe(CHAT_HISTORY_ERROR_CODES.textLimitExceeded);
      expect(getChatHistoryErrorCode(error)).toBe(
        CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
      );
      await expect(readHistorySnapshot(workspaceId, chatId)).resolves.toEqual(before);
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
      await expect(owner.newGadget(`workspace-over-limit-${crypto.randomUUID()}`, "Over limit"))
        .rejects.toThrow("Workspace limit reached");
      await expect(owner.listGadgets()).resolves.toHaveLength(100);
    });
  });
  it("ensures one manager profile, isolates A/B state, and reconnects to A", async () => {
    const managerA = managerId();
    const managerB = managerId();

    expect((await read(managerA)).status).toBe(404);
    await ensure(managerA);
    await ensure(managerA);
    expect((await read(managerA)).status).toBe(204);

    const sessionA = await connectNative(managerA);
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
        await workspace.updateCode(new Uint8Array());
      } finally {
        workspace[Symbol.dispose]();
      }

      await expect(waitForGadget(sessionA.api, gadgetId)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(sessionA);
    }

    await ensure(managerB);
    const sessionB = await connectNative(managerB);
    try {
      await expect(sessionB.api.whoami()).resolves.toMatchObject({
        type: "user",
        id: managerB,
      });
      await expect(sessionB.api.listGadgets()).resolves.not.toContainEqual(
          expect.objectContaining({id: gadgetId!}));
    } finally {
      close(sessionB);
    }

    const reconnectedA = await connectNative(managerA);
    try {
      await expect(reconnectedA.api.whoami()).resolves.toMatchObject({id: managerA});
      await expect(waitForGadget(reconnectedA.api, gadgetId!)).resolves.toMatchObject({
        id: gadgetId,
      });
    } finally {
      close(reconnectedA);
    }
  });

  it("rejects missing or malformed private context without opening the OS API", async () => {
    const knownManager = managerId();
    expect((await managerRequest("/_cybernest/manager", "GET")).status).toBe(400);
    expect((await managerRequest("/_cybernest/manager", "POST")).status).toBe(400);
    expect((await managerRequest("/_cybernest/manager", "GET", "not-a-uuid")).status)
        .toBe(400);

    const malformedApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...managerHeaders("not-a-uuid"),
      },
    }));
    expect(malformedApi.status).toBe(400);
    expect(malformedApi.webSocket).toBeNull();

    await ensure(knownManager);

    const missingLeaseApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...managerHeaders(knownManager),
      },
    }));
    expect(missingLeaseApi.status).toBe(503);
    expect(missingLeaseApi.webSocket).toBeNull();

    const expiredLeaseApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...privateManagerHeaders(knownManager, Date.now() - 1),
      },
    }));
    expect(expiredLeaseApi.status).toBe(503);
    expect(expiredLeaseApi.webSocket).toBeNull();

    const overlongLeaseApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...privateManagerHeaders(knownManager, Date.now() + 301_000),
      },
    }));
    expect(overlongLeaseApi.status).toBe(503);
    expect(overlongLeaseApi.webSocket).toBeNull();

    const malformedLeaseApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...privateManagerHeaders(knownManager),
        "X-Cybernest-Private-Lease-Expires-At": "not-an-integer",
      },
    }));
    expect(malformedLeaseApi.status).toBe(503);
    expect(malformedLeaseApi.webSocket).toBeNull();

    expect((await managerRequest("/_cybernest/manager/other", "GET", knownManager)).status)
        .toBe(404);

    const noManagerApi = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {Upgrade: "websocket"},
    }));
    expect(noManagerApi.status).toBe(400);
    expect(noManagerApi.webSocket).toBeNull();

    const publicRoot = await exports.default.fetch(new Request("https://workshop.invalid/"));
    expect(publicRoot.status).toBe(404);
  });

  it("closes the private native socket when its lease expires", async () => {
    const id = managerId();
    await ensure(id);
    const leaseExpiresAt = Date.now() + 250;
    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        Upgrade: "websocket",
        ...privateManagerHeaders(id, leaseExpiresAt),
      },
    }));

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new TypeError("Expected a WebSocket response.");
    socket.accept();

    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for private lease close."));
      }, 1_000);
      const onClose = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      socket.addEventListener("close", onClose, {once: true});
    });

    try {
      await expect(closed).resolves.toBeUndefined();
    } finally {
      socket.close();
    }
  });

  it("keeps a Manager workspace owner-only and blocks share creation", async () => {
    const ownerId = managerId();
    const otherId = managerId();
    const shareRecipientId = managerId();
    await ensure(ownerId);
    await ensure(otherId);
    await ensure(shareRecipientId);

    const ownerSession = await connectNative(ownerId);
    let workspaceId: string | undefined;
    try {
      using workspace = await ownerSession.api.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
    } finally {
      close(ownerSession);
    }

    const ownerNotifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseerStub = exports.OverseerDurableObject
      .get(exports.OverseerDurableObject.idFromString(workspaceId!));
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
        await expect(
          ownerOverseer.revokeShareLink("missing-link", ["keep-user"]),
        ).rejects.toThrow("A private Manager runtime cannot keep shared users.");

        // Seed pre-private-mode sharing state through the real SharingManager. Product RPCs above
        // remain closed; this direct fixture represents records persisted by an older OS pin.
        const legacyShare = await runInDurableObject(overseerStub, async (instance) => {
          const sharing = await (instance as unknown as {
            impl: {getSharingManager(): Promise<LegacySharingFixture>};
          }).impl.getSharingManager();
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
          await expect(overseerStub.open(
            exports.UserDurableObject.idFromName(otherId).toString(),
            otherId,
            collaboratorNotifyClosed,
          )).rejects.toMatchObject({code: "WORKSPACE_ACCESS_DENIED"});
        } finally {
          collaboratorNotifyClosed[Symbol.dispose]();
        }

        const shareNotifyClosed = new NativeRpcStub<() => void>(() => {});
        try {
          await expect(overseerStub.open(
            exports.UserDurableObject.idFromName(shareRecipientId).toString(),
            shareRecipientId,
            shareNotifyClosed,
            legacyShare.key,
          )).rejects.toMatchObject({code: "WORKSPACE_ACCESS_DENIED"});
        } finally {
          shareNotifyClosed[Symbol.dispose]();
        }
        await expect(runInDurableObject(overseerStub, async (instance) => {
          const sharing = await (instance as unknown as {
            impl: {getSharingManager(): Promise<LegacySharingFixture>};
          }).impl.getSharingManager();
          return sharing.isCollaborator(shareRecipientId);
        })).resolves.toBe(false);

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
    await expect(runInDurableObject(overseerStub, async () => {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    })).rejects.toMatchObject({durableObjectReset: true});
    overseerStub = exports.OverseerDurableObject
      .get(exports.OverseerDurableObject.idFromString(workspaceId!));

    const externalGateway = (exports as unknown as {
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
    }).ExternalMessageGateway({props: {source: "private-test"}});
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
      await expect(externalGateway.submitExternalMessage({
        callerEmail: externalEmail,
        gadgetKey: "external-gadget",
        chatKey: "external-chat",
        messageKey: "external-message",
        gadgetTitle: "External",
        prompt: "hello",
        chatGatewayRpcTarget: responseTarget,
      })).resolves.toMatchObject({accepted: false});

      await expect(overseerStub.receiveExternalMessage({
        callerEmail: externalEmail,
        externalChatKey: "private-test:existing-chat",
        idempotencyKey: "private-test:existing-message",
        prompt: "hello existing workspace",
        chatGatewayRpcTarget: responseTarget,
        title: "External",
      })).resolves.toMatchObject({accepted: false});

      await expect(
        exports.UserDurableObject
          .get(exports.UserDurableObject.idFromName(externalEmail))
          .whoamiIfExists(),
      ).resolves.toBeNull();

      await expect(runInDurableObject(externalWorkspace, async (instance) => {
        const storage = (instance as unknown as WorkspaceStorageFixture).impl.storage;
        return {
          ownerId: storage.ownerId.get(),
          chats: [...storage.chatMeta.list()].length,
          externalChats: [...storage.externalChats.list()].length,
        };
      })).resolves.toEqual({ownerId: undefined, chats: 0, externalChats: 0});

      await expect(runInDurableObject(overseerStub, async (instance) => {
        const storage = (instance as unknown as WorkspaceStorageFixture).impl.storage;
        return {
          chats: [...storage.chatMeta.list()].length,
          externalChats: [...storage.externalChats.list()].length,
        };
      })).resolves.toEqual(existingStateBefore);
    } finally {
      responseTarget[Symbol.dispose]();
    }

  });
});
