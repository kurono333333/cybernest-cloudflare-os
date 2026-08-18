import { describe, expect, it, vi } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { DEFAULT_ADMIN_CONFIG, serializeAdminConfig } from "../src/admin-config.js";
import type {
  ConversationContextPromptBudget,
  ConversationContextSource,
  ConversationContextTurn,
  CybernestConversationContextState,
} from "../src/agent.js";
import {
  OverseerDurableObject,
  resolveConversationContextForTurn,
} from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseer(
    getConfig: () => Promise<string | null>,
    hook: { enabled: boolean; vendorId?: string; callback?: object } | null =
        { enabled: true, vendorId: "email" },
    legacyVendorId?: string,
): OverseerDurableObject {
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    env: { BLUEPRINTS: { get: getConfig } },
    impl: {
      storage: {
        boundHooks: { get: () => hook && ({ ...hook, gatekeeperId: 1 }) },
        gatekeepers: {
          get: () => legacyVendorId && {
            creationSpec: {
              type: "gatekeeper",
              vendorId: legacyVendorId,
              resourceUrl: "https://example.com",
              typeUrlPattern: "https://*",
            },
          },
        },
      },
    },
  });
  return overseer;
}

describe("OverseerDurableObject.startHook", () => {
  it.each([
    ["ordinary", DEFAULT_ADMIN_CONFIG, "email"],
    ["ambient", {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "optional" as const },
    }, "scheduler"],
  ])("allows delivery for an enabled %s vendor", async (_kind, config, vendorId) => {
    let callback = {};
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId, callback });

    await expect(overseer.startHook(1)).resolves.toMatchObject({ callback });
  });

  it("rejects delivery for an administratively disabled ordinary vendor", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(async () => serializeAdminConfig(config));

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery for an administratively disabled ambient vendor", async () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: { scheduler: "disabled" as const },
    };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true, vendorId: "scheduler" });

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("enforces vendor policy for legacy hooks without a denormalized vendor ID", async () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, disabledGatekeepers: ["email"] };
    let overseer = makeOverseer(
        async () => serializeAdminConfig(config), { enabled: true }, "email");

    await expect(overseer.startHook(1)).rejects.toThrow("Gatekeeper is disabled.");
  });

  it("rejects delivery when admin-config KV access fails", async () => {
    let overseer = makeOverseer(async () => { throw new Error("KV unavailable"); });

    await expect(overseer.startHook(1)).rejects.toThrow("KV unavailable");
  });

  it("rejects delivery when the hook was disabled", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG),
        { enabled: false, vendorId: "email" });

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("rejects delivery when the hook was deleted", async () => {
    let overseer = makeOverseer(
        async () => serializeAdminConfig(DEFAULT_ADMIN_CONFIG), null);

    await expect(overseer.startHook(1)).rejects.toThrow("Hook has been deleted or disabled.");
  });
});

async function makeTargetOverseer(gadgetId?: number) {
  let controllerEnable = vi.fn(async (_initiator: object, _target: object) => {});
  let record = {
    id: 4,
    actionId: 12,
    gatekeeperId: 1,
    gadgetId,
    controller: {enable: controllerEnable},
    callback: {},
    description: {title: "Incoming email", description: "Receives email"},
    enabled: false,
  };
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId: "user-id",
      isCybernestPrivateRuntime: () => false,
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ({id: "profile-id", name: "Test User"}),
        }),
      },
      ctx: {
        id: {toString: () => "workspace-id"},
        exports: {GatekeeperHookLoopback: ({props}: {props: object}) => props},
      },
      storage: {
        prohibitAllSharing: {get: () => false},
        boundHooks: {get: () => record, put: vi.fn()},
        actions: {get: () => undefined, put: vi.fn()},
      },
    },
  } satisfies Pick<OverseerDurableObject, "open"> & {impl: object};
  let notifyClosed = new NativeRpcStub<() => void>(() => {});
  let client = await overseer.open("user-id", "profile-id", notifyClosed);
  return {client, controllerEnable};
}

describe("hook target", () => {

  it("passes the workspace and gadget IDs to enable()", async () => {
    let {client, controllerEnable} = await makeTargetOverseer(17);

    await client.enableHook(4);

    expect(controllerEnable).toHaveBeenCalledTimes(1);
    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id", gadgetId: 17});
  });

  it("omits the gadget ID for a hook that is not pinned to one", async () => {
    let {client, controllerEnable} = await makeTargetOverseer();

    await client.enableHook(4);

    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id"});
  });

});

async function makeOwnerChatOverseer() {
  let newChat = vi.fn(async (..._args: unknown[]) => 7);
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId: "owner-id",
      isCybernestPrivateRuntime: () => false,
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ({id: "profile-id", name: "Test User"}),
          getChatContext: async () => ({profile: {type: "user", id: "profile-id", name: "Test User"}}),
        }),
      },
      ctx: {id: {toString: () => "workspace-id"}},
      storage: {},
      newChat,
    },
  } satisfies Pick<OverseerDurableObject, "open"> & {impl: object};
  let notifyClosed = new NativeRpcStub<() => void>(() => {});
  let client = await overseer.open("owner-id", "profile-id", notifyClosed);
  return {client, newChat};
}

describe("conversation capture owner path", () => {
  it("marks an owner-created AI chat as eligible before its first turn", async () => {
    let {client, newChat} = await makeOwnerChatOverseer();

    await expect(client.newChat("hello", null)).resolves.toBe(7);
    expect(newChat).toHaveBeenCalledTimes(1);
    expect(newChat.mock.calls[0].at(-1)).toBe(true);
  });
});

const PINNED_REVISION = "44444444-4444-4444-8444-444444444444";
const OTHER_REVISION = "55555555-5555-4555-8555-555555555555";

function conversationSource(
    revisionId = PINNED_REVISION, content = "  exact source\n\n"): ConversationContextSource {
  return {
    revisionId,
    documentKey: "conversation-context",
    contentHash: "a".repeat(64),
    content,
  };
}

function conversationBudget(
    overrides: Partial<ConversationContextPromptBudget> = {},
): ConversationContextPromptBudget {
  return {
    inputBudget: 100_000,
    systemPromptTokens: 100,
    projectionTokens: 100,
    ...overrides,
  };
}

function conversationReaders(options: {
  current?: () => Promise<ConversationContextSource | null>;
  historical?: (revisionId: string) => Promise<ConversationContextSource | null>;
  persist?: (state: CybernestConversationContextState) => Promise<void>;
} = {}) {
  return {
    readCurrent: vi.fn(options.current ?? (async () => conversationSource())),
    readRevision: vi.fn(options.historical ?? (async () => conversationSource())),
    persist: vi.fn(options.persist ?? (async () => {})),
  };
}

describe("conversation context lifecycle", () => {
  it("pins the current source and reuses that read during a compaction replay", async () => {
    let readers = conversationReaders();
    let turn: ConversationContextTurn = {resolved: false};

    await expect(resolveConversationContextForTurn(
        {state: "eligible"}, turn, conversationBudget(), readers)).resolves.toContain(
        "revision: " + PINNED_REVISION);
    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, turn, conversationBudget(), readers))
      .resolves.toContain("exact source");

    expect(readers.readCurrent).toHaveBeenCalledTimes(1);
    expect(readers.readRevision).not.toHaveBeenCalled();
    expect(readers.persist).toHaveBeenCalledWith({state: "pinned", revisionId: PINNED_REVISION});
  });

  it("reads the pinned historical revision once for each new logical turn", async () => {
    let readers = conversationReaders({
      historical: async revisionId => conversationSource(revisionId, "historical source"),
    });

    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, {resolved: false},
        conversationBudget(), readers)).resolves.toContain("historical source");
    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, {resolved: false},
        conversationBudget(), readers)).resolves.toContain("historical source");

    expect(readers.readCurrent).not.toHaveBeenCalled();
    expect(readers.readRevision).toHaveBeenNthCalledWith(1, PINNED_REVISION);
    expect(readers.readRevision).toHaveBeenNthCalledWith(2, PINNED_REVISION);
  });

  it("does not replace a pin when the historical read fails or returns another revision", async () => {
    let readers = conversationReaders({
      historical: async () => conversationSource(OTHER_REVISION),
    });

    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, {resolved: false},
        conversationBudget(), readers)).resolves.toBe("");
    expect(readers.persist).not.toHaveBeenCalled();

    readers = conversationReaders({
      historical: async () => { throw new Error("temporary read failure"); },
    });
    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, {resolved: false},
        conversationBudget(), readers)).resolves.toBe("");
    expect(readers.persist).not.toHaveBeenCalled();
  });

  it.each([
    ["body size", "x".repeat(64 * 1024 + 1), conversationBudget()],
    ["resolved input budget", "small source", conversationBudget({inputBudget: 250})],
  ])("moves an eligible source to deferred on %s without projecting its body", async (
      _reason, content, budget,
  ) => {
    let readers = conversationReaders({current: async () => conversationSource(PINNED_REVISION, content)});

    await expect(resolveConversationContextForTurn(
        {state: "eligible"}, {resolved: false}, budget, readers)).resolves.toBe("");
    expect(readers.persist).toHaveBeenCalledWith({
      state: "deferred", revisionId: PINNED_REVISION,
    });
  });

  it("persists unavailable after a first current read failure", async () => {
    let readers = conversationReaders({
      current: async () => { throw new Error("capability unavailable"); },
    });

    await expect(resolveConversationContextForTurn(
        {state: "eligible"}, {resolved: false}, conversationBudget(), readers))
      .resolves.toBe("");
    expect(readers.persist).toHaveBeenCalledWith({state: "unavailable"});
  });

  it("persists none when the first current read finds no source", async () => {
    let readers = conversationReaders({current: async () => null});

    await expect(resolveConversationContextForTurn(
        {state: "eligible"}, {resolved: false}, conversationBudget(), readers))
      .resolves.toBe("");
    expect(readers.persist).toHaveBeenCalledWith({state: "none"});
  });

  it("moves a pinned source to deferred when a later historical body is unbounded", async () => {
    let readers = conversationReaders({
      historical: async revisionId => conversationSource(revisionId, "x".repeat(64 * 1024 + 1)),
    });

    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, {resolved: false},
        conversationBudget(), readers)).resolves.toBe("");
    expect(readers.persist).toHaveBeenCalledWith({
      state: "deferred", revisionId: PINNED_REVISION,
    });
  });

  it("can defer the budget decision until the existing history compacts", async () => {
    let readers = conversationReaders();
    let turn: ConversationContextTurn = {resolved: false};

    await expect(resolveConversationContextForTurn(
        {state: "eligible"}, turn,
        conversationBudget({inputBudget: 250, allowCompaction: true}), readers))
      .resolves.toContain("exact source");
    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: PINNED_REVISION}, turn,
        conversationBudget({inputBudget: 250}), readers)).resolves.toBe("");
    expect(readers.persist).toHaveBeenLastCalledWith({
      state: "deferred", revisionId: PINNED_REVISION,
    });
  });

  it("never resolves legacy, none, unavailable, or deferred chats", async () => {
    let readers = conversationReaders();
    let states: (CybernestConversationContextState | undefined)[] = [
      undefined,
      {state: "none"},
      {state: "unavailable"},
      {state: "deferred", revisionId: PINNED_REVISION},
    ];

    for (let state of states) {
      await expect(resolveConversationContextForTurn(
          state, {resolved: false}, conversationBudget(), readers)).resolves.toBe("");
    }
    expect(readers.readCurrent).not.toHaveBeenCalled();
    expect(readers.readRevision).not.toHaveBeenCalled();
    expect(readers.persist).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed persisted pin", async () => {
    let readers = conversationReaders();

    await expect(resolveConversationContextForTurn(
        {state: "pinned", revisionId: "not-a-uuid"} as never,
        {resolved: false}, conversationBudget(), readers)).resolves.toBe("");
    expect(readers.readCurrent).not.toHaveBeenCalled();
    expect(readers.readRevision).not.toHaveBeenCalled();
    expect(readers.persist).not.toHaveBeenCalled();
  });
});
