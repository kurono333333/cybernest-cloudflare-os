import { RpcStub, RpcTarget } from "capnweb";
import { createOpenGadgetError } from "@gadgets/workshop-shared/api";
import type {
  ActionLogEntry,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatSubscriber,
  ActionsSubscriber,
  AuthenticatedApi,
  GadgetMetadataWithTimestamps,
  ListOutputsResult,
  Overseer,
} from "@gadgets/workshop-shared/api";
import type {
  CybernestActionSubscriber,
  CybernestChatSubscriber,
  CybernestWorkspaceMetadata,
} from "@gadgets/workshop-shared/cybernest-workspace-api";
import { describe, expect, it, vi } from "vitest";

import { CybernestWorkspaceApiImpl } from "../src/cybernest-workspace-api";

const timestamp = new Date("2026-08-16T00:00:00.000Z");

const workspaceMetadata = (
    id: string,
    lifecycle: "unused" | "active" | undefined = "active",
): GadgetMetadataWithTimestamps => ({
  id,
  title: "Workspace title",
  pinned: true,
  created: timestamp,
  lastActive: timestamp,
  ...(lifecycle === undefined ? {} : {lifecycle}),
});

const emptyActions = (): ActionLogEntry[] => [];

const makeOverseer = (
    overrides: Partial<Overseer> = {}): Overseer => ({
  getMetadata: vi.fn().mockResolvedValue({id: "workspace-1", title: "Workspace title", pinned: true}),
  subscribeToMetadata: vi.fn(),
  listModels: vi.fn().mockResolvedValue([{type: "agent", id: "model-1", name: "Model 1"}]),
  listChats: vi.fn().mockResolvedValue([]),
  getChatHistory: vi.fn().mockResolvedValue({messages: []}),
  subscribeToChat: vi.fn(),
  newChat: vi.fn().mockResolvedValue(1),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  stopAgent: vi.fn().mockResolvedValue(undefined),
  retryAgent: vi.fn().mockResolvedValue(undefined),
  listActions: vi.fn().mockImplementation(emptyActions),
  subscribeToActions: vi.fn(),
  approveAction: vi.fn().mockResolvedValue(undefined),
  rejectAction: vi.fn().mockResolvedValue(undefined),
  ...overrides,
} as unknown as Overseer);

const makeApi = (
    overrides: Partial<AuthenticatedApi> = {}): AuthenticatedApi => ({
  listGadgets: vi.fn().mockResolvedValue([]),
  newGadget: vi.fn().mockResolvedValue(makeOverseer()),
  openGadget: vi.fn().mockResolvedValue(makeOverseer()),
  listOutputs: vi.fn().mockResolvedValue({outputs: [], catchingUp: false}),
  ...overrides,
} as unknown as AuthenticatedApi);

const openSession = async (
    api: AuthenticatedApi = makeApi()): Promise<Awaited<ReturnType<CybernestWorkspaceApiImpl["createWorkspace"]>>> =>
  new CybernestWorkspaceApiImpl(api).createWorkspace();

describe("CybernestWorkspaceApiImpl", () => {
  it("projects workspace and output metadata into safe DTOs", async () => {
    const listGadgets = vi.fn().mockResolvedValue([
      workspaceMetadata("workspace-1"),
    ]);
    const outputs: ListOutputsResult = {
      catchingUp: true,
      outputs: [{
        workspaceId: "workspace-1",
        workpieceId: 4,
        title: "Report",
        workspaceTitle: "Workspace title",
        created: timestamp,
        lastActive: timestamp,
        output: {id: "document", noun: "Document", plural: "Documents", icon: "fileText"},
        owner: {type: "user", id: "owner-secret", name: "Owner"},
        resourceUrl: "https://secret.invalid/resource",
      }],
    };
    const root = new CybernestWorkspaceApiImpl(makeApi({
      listGadgets,
      listOutputs: vi.fn().mockResolvedValue(outputs),
    }));

    await expect(root.listWorkspaces()).resolves.toEqual([{
      id: "workspace-1",
      title: "Workspace title",
      createdAt: timestamp.toISOString(),
      lastActiveAt: timestamp.toISOString(),
      lifecycle: "active",
      pinned: true,
    }]);
    await expect(root.listOutputs()).resolves.toEqual({
      catchingUp: true,
      outputs: [{
        workspaceId: "workspace-1",
        workpieceId: 4,
        title: "Report",
        workspaceTitle: "Workspace title",
        createdAt: timestamp.toISOString(),
        lastActiveAt: timestamp.toISOString(),
        format: {id: "document", noun: "Document", plural: "Documents"},
      }],
    });
  });

  it("projects an explicitly created empty workspace without inventing activity", async () => {
    const root = new CybernestWorkspaceApiImpl(makeApi({
      listGadgets: vi.fn().mockResolvedValue([workspaceMetadata("workspace-unused", "unused")]),
    }));

    await expect(root.listWorkspaces()).resolves.toEqual([{
      id: "workspace-unused",
      title: "Workspace title",
      createdAt: timestamp.toISOString(),
      lastActiveAt: null,
      lifecycle: "unused",
      pinned: true,
    }]);
  });

  it("treats a legacy fully-created record without lifecycle as active", async () => {
    const root = new CybernestWorkspaceApiImpl(makeApi({
      listGadgets: vi.fn().mockResolvedValue([workspaceMetadata("workspace-legacy", undefined)]),
    }));

    await expect(root.listWorkspaces()).resolves.toMatchObject([{
      id: "workspace-legacy",
      lifecycle: "active",
      lastActiveAt: timestamp.toISOString(),
    }]);
  });

  it("fails closed on an unknown native workspace lifecycle", async () => {
    const root = new CybernestWorkspaceApiImpl(makeApi({
      listGadgets: vi.fn().mockResolvedValue([{
        ...workspaceMetadata("workspace-unknown"),
        lifecycle: "retired",
      } as unknown as GadgetMetadataWithTimestamps]),
    }));

    await expect(root.listWorkspaces()).rejects.toMatchObject({
      code: "cybernest.unknown_result",
    });
  });

  it("fails closed on malformed native metadata", async () => {
    const root = new CybernestWorkspaceApiImpl(makeApi({
      listGadgets: vi.fn().mockResolvedValue([{
        ...workspaceMetadata("workspace-1"),
        created: new Date(Number.NaN),
      }]),
    }));

    await expect(root.listWorkspaces()).rejects.toMatchObject({
      code: "cybernest.unknown_result",
    });
  });

  it("projects chat history without exposing native changes or binding fields", async () => {
    const nativeMessage: AiChatMessage = {
      chatId: 5,
      sequence: 1,
      timestamp,
      author: {type: "user", id: "user-1", name: "Owner"},
      type: "message",
      message: "hello",
      reasoning: "internal reasoning",
      toolCalls: [{
        toolCallId: "call-1",
        toolName: "readFile",
        input: {filename: "private.ts"},
        output: "read result",
      }],
    };
    const nativeChanges: AiChatMessage = {
      chatId: 5,
      sequence: 2,
      timestamp,
      author: {type: "agent", id: "model-1", name: "Model 1"},
      type: "changes",
      update: new Uint8Array([1, 2, 3]),
      createdGadgets: [{gadgetId: 4, title: "Created", bindingName: "created"}],
    };
    const history: AiChatHistoryPage = {
      messages: [nativeMessage, nativeChanges],
      compacted: {
        to: 1,
        summary: "older context",
        proposedChanges: new Uint8Array([4, 5, 6]),
      },
    };
    const getChatHistory = vi.fn().mockResolvedValue(history);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({getChatHistory})),
    }));

    await expect(session.getChatHistory(5, 1)).resolves.toEqual({
      messages: [
        {
          kind: "message",
          chatId: 5,
          sequence: 1,
          timestamp: timestamp.toISOString(),
          author: {type: "user", id: "user-1", name: "Owner"},
          text: "hello",
          reasoning: "internal reasoning",
          toolCalls: [{toolCallId: "call-1", output: "read result"}],
        },
        {
          kind: "result",
          chatId: 5,
          sequence: 2,
          timestamp: timestamp.toISOString(),
          author: {type: "agent", id: "model-1", name: "Model 1"},
          hasCodeChange: true,
          createdWorkpieces: [{id: 4, title: "Created"}],
        },
      ],
      hasPreviousPage: true,
      summary: "older context",
    });
    expect(getChatHistory).toHaveBeenCalledWith(5, 1);
  });

  it("projects model and chat metadata into the restricted read DTOs", async () => {
    const listModels = vi.fn().mockResolvedValue([
      {type: "agent", id: "model-1", name: "Model 1", provider: "private"},
    ]);
    const listChats = vi.fn().mockResolvedValue([{
      id: 5,
      title: "Chat",
      started: timestamp,
      lastActive: timestamp,
      activeAgent: {type: "agent", id: "model-1", name: "Model 1"},
      hasProposedChanges: true,
      totalCost: 999,
    }]);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({listModels, listChats})),
    }));

    await expect(session.listModels()).resolves.toEqual([
      {id: "model-1", name: "Model 1"},
    ]);
    await expect(session.listChats()).resolves.toEqual([{
      id: 5,
      title: "Chat",
      startedAt: timestamp.toISOString(),
      lastActiveAt: timestamp.toISOString(),
      active: true,
      hasProposedChanges: true,
    }]);
    expect(listModels).toHaveBeenCalledOnce();
    expect(listChats).toHaveBeenCalledOnce();
  });

  it("projects metadata subscription callbacks without native ownership fields", async () => {
    let nativeCallback: Parameters<Overseer["subscribeToMetadata"]>[0] | undefined;
    class NativeSubscription extends RpcTarget {}
    const subscribeToMetadata = vi.fn().mockImplementation(async (
        callback: Parameters<Overseer["subscribeToMetadata"]>[0]) => {
      nativeCallback = callback;
      return new RpcStub<{}>(new NativeSubscription());
    });
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToMetadata})),
    }));
    const received = vi.fn();
    const callback = new RpcStub<(metadata: CybernestWorkspaceMetadata) => void>(received);

    const subscription = await session.subscribeToMetadata(callback);
    if (nativeCallback === undefined) throw new Error("Native metadata callback was not captured.");
    await nativeCallback({
      id: "workspace-1",
      title: "Workspace title",
      pinned: true,
      owner: {type: "user", id: "owner-secret", name: "Owner"},
      role: "use",
      sharingProhibited: true,
    });

    expect(received).toHaveBeenCalledWith({
      id: "workspace-1",
      title: "Workspace title",
      pinned: true,
    });
    subscription[Symbol.dispose]();
  });

  it("maps expected open failures and hides unexpected native errors", async () => {
    const notFound = new CybernestWorkspaceApiImpl(makeApi({
      openGadget: vi.fn().mockRejectedValue(
        createOpenGadgetError("WORKSPACE_NOT_FOUND"),
      ),
    }));
    await expect(notFound.openWorkspace("workspace-1")).rejects.toMatchObject({
      code: "cybernest.workspace_not_found",
    });

    const denied = new CybernestWorkspaceApiImpl(makeApi({
      openGadget: vi.fn().mockRejectedValue(
        createOpenGadgetError("WORKSPACE_ACCESS_DENIED"),
      ),
    }));
    await expect(denied.openWorkspace("workspace-1")).rejects.toMatchObject({
      code: "cybernest.unauthorized",
    });

    const unavailable = new CybernestWorkspaceApiImpl(makeApi({
      openGadget: vi.fn().mockRejectedValue(new Error("internal native detail")),
    }));
    await expect(unavailable.openWorkspace("workspace-1")).rejects.toMatchObject({
      code: "cybernest.os_unavailable",
    });
    await expect(unavailable.openWorkspace("workspace-1")).rejects.not.toThrow(
      "internal native detail",
    );
  });

  it("forwards safe chat callbacks and drops draft and code stream payloads", async () => {
    let nativeSubscriber: RpcStub<AiChatSubscriber> | undefined;
    class NativeSubscription extends RpcTarget {}
    const subscribeToChat = vi.fn().mockImplementation(async (subscriber: RpcStub<AiChatSubscriber>) => {
      nativeSubscriber = subscriber;
      return new RpcStub<{}>(new NativeSubscription());
    });
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToChat})),
    }));
    const streamGeneration = vi.fn();
    const metadata = vi.fn();
    const deleted = vi.fn();
    const message = vi.fn();
    const stream = vi.fn();
    const subscriber = new RpcStub<CybernestChatSubscriber>({
      streamGeneration,
      metadata,
      deleted,
      message,
      stream,
    });

    const subscription = await session.subscribeToChat(subscriber, timestamp.toISOString());
    expect(subscribeToChat).toHaveBeenCalledWith(expect.anything(), timestamp);
    if (nativeSubscriber === undefined) throw new Error("Native chat subscriber was not captured.");
    const nativeMessage: AiChatMessage = {
      chatId: 5,
      sequence: 1,
      timestamp,
      author: {type: "user", id: "user-1", name: "Owner"},
      type: "message",
      message: "hello",
    };
    await nativeSubscriber.streamGeneration(2);
    await nativeSubscriber.metadata({
      id: 5,
      title: "Chat",
      started: timestamp,
      lastActive: timestamp,
      activeAgent: {type: "agent", id: "model-1", name: "Model 1"},
    });
    await nativeSubscriber.deleted(5);
    await nativeSubscriber.message(nativeMessage);
    await nativeSubscriber.stream(5, {type: "textDelta", delta: "safe"});
    await nativeSubscriber.stream(5, {
      type: "toolCodeDelta",
      toolCallId: "call-1",
      delta: "private code",
    });
    await nativeSubscriber.stream(5, {type: "codeUpdate", update: new Uint8Array([7])});
    await nativeSubscriber.draftUpdate(
      5,
      timestamp,
      {type: "user", id: "user-1", name: "Owner"},
      new Uint8Array([8]),
    );
    await nativeSubscriber.draftCleared(5);

    expect(streamGeneration).toHaveBeenCalledWith(2);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 5,
      active: true,
      hasProposedChanges: false,
    }));
    expect(deleted).toHaveBeenCalledWith(5);
    expect(message).toHaveBeenCalledWith(expect.objectContaining({
      kind: "message",
      text: "hello",
    }));
    expect(stream).toHaveBeenCalledWith(5, {type: "text_delta", delta: "safe"});
    expect(stream).toHaveBeenCalledTimes(1);
    subscription[Symbol.dispose]();
  });

  it("disposes the native chat subscription exactly once", async () => {
    const nativeSubscriptionDispose = vi.fn();
    class NativeSubscription extends RpcTarget {
      [Symbol.dispose](): void {
        nativeSubscriptionDispose();
      }
    }
    const subscribeToChat = vi.fn().mockResolvedValue(
      new RpcStub<{}>(new NativeSubscription()),
    );
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToChat})),
    }));
    const subscriber = new RpcStub<CybernestChatSubscriber>({
      streamGeneration: vi.fn(),
      metadata: vi.fn(),
      deleted: vi.fn(),
      message: vi.fn(),
      stream: vi.fn(),
    });

    const subscription = await session.subscribeToChat(subscriber);
    subscription[Symbol.dispose]();
    subscription[Symbol.dispose]();

    expect(nativeSubscriptionDispose).toHaveBeenCalledOnce();
  });

  it("rejects an invalid chat cursor before opening a native subscription", async () => {
    const subscribeToChat = vi.fn();
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToChat})),
    }));
    const subscriber = new RpcStub<CybernestChatSubscriber>({
      streamGeneration: vi.fn(),
      metadata: vi.fn(),
      deleted: vi.fn(),
      message: vi.fn(),
      stream: vi.fn(),
    });

    await expect(session.subscribeToChat(subscriber, "not-a-date")).rejects.toMatchObject({
      code: "cybernest.invalid_mutation",
    });
    expect(subscribeToChat).not.toHaveBeenCalled();
  });

  it("delegates the allowed chat mutations and pending action rejection", async () => {
    const newChat = vi.fn().mockResolvedValue(2);
    const sendChatMessage = vi.fn().mockResolvedValue(undefined);
    const stopAgent = vi.fn().mockResolvedValue(undefined);
    const retryAgent = vi.fn().mockResolvedValue(undefined);
    const rejectAction = vi.fn().mockResolvedValue(undefined);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({
        newChat,
        sendChatMessage,
        stopAgent,
        retryAgent,
        rejectAction,
        listActions: vi.fn().mockResolvedValue([{
          id: 7,
          type: "action",
          state: "pending",
          resourceTitle: "Confluence",
          createdAt: timestamp,
          description: {
            title: "Edit page",
            description: "Update the page.",
            implementsRevert: true,
            actionKind: {tag: "confluence.editContent", label: "Edit content"},
          },
        }]),
      })),
    }));

    await expect(session.newChat("hello", "model-1")).resolves.toBe(2);
    await expect(session.sendChatMessage(2, "next", null)).resolves.toBeUndefined();
    await expect(session.stopAgent(2)).resolves.toBeUndefined();
    await expect(session.retryAgent(2, "model-1")).resolves.toBeUndefined();
    await expect(session.rejectAction(7)).resolves.toBeUndefined();

    expect(newChat).toHaveBeenCalledWith("hello", "model-1");
    expect(sendChatMessage).toHaveBeenCalledWith(2, "next", null);
    expect(stopAgent).toHaveBeenCalledWith(2);
    expect(retryAgent).toHaveBeenCalledWith(2, "model-1");
    expect(rejectAction).toHaveBeenCalledWith(7);
  });

  it("rejects an unavailable model before starting a native chat", async () => {
    const newChat = vi.fn().mockResolvedValue(1);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({
        newChat,
        listModels: vi.fn().mockResolvedValue([{type: "agent", id: "model-1", name: "Model 1"}]),
      })),
    }));

    await expect(session.newChat("hello", "missing-model")).rejects.toMatchObject({
      code: "cybernest.invalid_model",
    });
    expect(newChat).not.toHaveBeenCalled();
  });

  it("blocks unknown action kinds without calling native approve", async () => {
    const approveAction = vi.fn().mockResolvedValue(undefined);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({
        approveAction,
        listActions: vi.fn().mockResolvedValue([{
          id: 7,
          type: "action",
          state: "pending",
          resourceTitle: "External page",
          createdAt: timestamp,
          description: {
            title: "Unknown action",
            description: "Do something risky.",
            implementsRevert: false,
            actionKind: {tag: "unknown.action", label: "Unknown"},
          },
        }]),
      })),
    }));

    await expect(session.listActions()).resolves.toMatchObject([{
      id: 7,
      decision: "blocked",
      canApprove: false,
      canReject: true,
      blockedReason: "high_impact_action",
    }]);
    await expect(session.approveAction(7)).rejects.toMatchObject({
      code: "cybernest.blocked_action",
    });
    expect(approveAction).not.toHaveBeenCalled();
  });

  it("does not expose reject for observation or hook entries", async () => {
    const rejectAction = vi.fn().mockResolvedValue(undefined);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({
        rejectAction,
        listActions: vi.fn().mockResolvedValue([
          {
            id: 10,
            type: "observation",
            state: "pending",
            resourceTitle: "External page",
            createdAt: timestamp,
            description: {title: "Observe", description: "Observe safely."},
          },
          {
            id: 11,
            type: "bindHook",
            state: "pending",
            resourceTitle: "External page",
            createdAt: timestamp,
            description: {title: "Hook", description: "Keep a hook."},
            enabled: true,
          },
        ]),
      })),
    }));

    await expect(session.listActions()).resolves.toMatchObject([
      {id: 10, canApprove: false, canReject: false, blockedReason: "not_manual_action"},
      {id: 11, canApprove: false, canReject: false, blockedReason: "not_manual_action"},
    ]);
    await expect(session.rejectAction(10)).rejects.toMatchObject({
      code: "cybernest.blocked_action",
    });
    await expect(session.rejectAction(11)).rejects.toMatchObject({
      code: "cybernest.blocked_action",
    });
    expect(rejectAction).not.toHaveBeenCalled();
  });

  it("allows only the four explicitly approved action tags", async () => {
    const approveAction = vi.fn().mockResolvedValue(undefined);
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({
        approveAction,
        listActions: vi.fn().mockResolvedValue([{
          id: 8,
          type: "action",
          state: "pending",
          resourceTitle: "Confluence",
          createdAt: timestamp,
          description: {
            title: "Edit page",
            description: "Update the page.",
            implementsRevert: true,
            actionKind: {tag: "confluence.editContent", label: "Edit content"},
          },
        }]),
      })),
    }));

    await expect(session.listActions()).resolves.toMatchObject([{
      id: 8,
      decision: "reviewable",
      canApprove: true,
      canReject: true,
      kindLabel: "Edit content",
    }]);
    await expect(session.approveAction(8)).resolves.toBeUndefined();
    expect(approveAction).toHaveBeenCalledWith(8);
  });

  it("projects action callbacks and disposes the native subscription", async () => {
    const nativeSubscriptionDispose = vi.fn();
    class NativeSubscription extends RpcTarget {
      [Symbol.dispose](): void {
        nativeSubscriptionDispose();
      }
    }
    const nativeSubscriber = vi.fn();
    const subscribeToActions = vi.fn().mockImplementation(async (subscriber: RpcStub<ActionsSubscriber>) => {
      nativeSubscriber(subscriber);
      return new RpcStub<{}>(new NativeSubscription());
    });
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToActions})),
    }));
    const entry = vi.fn();
    const ready = vi.fn();
    const subscriber = new RpcStub<CybernestActionSubscriber>({entry, ready});

    const subscription = await session.subscribeToActions(subscriber);
    const forwardedSubscriber = nativeSubscriber.mock.calls[0]?.[0] as RpcStub<ActionsSubscriber>;
    const action: ActionLogEntry = {
      id: 9,
      type: "action",
      state: "pending",
      resourceTitle: "Confluence",
      createdAt: timestamp,
      description: {
        title: "Edit page",
        description: "Update the page.",
        implementsRevert: true,
        actionKind: {tag: "confluence.editContent", label: "Edit content"},
      },
    };

    await forwardedSubscriber.ready();
    await forwardedSubscriber.entry(action);

    expect(ready).toHaveBeenCalledOnce();
    expect(entry).toHaveBeenCalledWith(expect.objectContaining({
      id: 9,
      decision: "reviewable",
      canApprove: true,
    }));

    subscription[Symbol.dispose]();
    expect(nativeSubscriptionDispose).toHaveBeenCalledOnce();
  });

  it("disposes client callback stubs when native action subscription setup rejects", async () => {
    const clientDispose = vi.fn();
    const subscribeToActions = vi.fn().mockRejectedValue(new Error("subscription setup failed"));
    const session = await openSession(makeApi({
      newGadget: vi.fn().mockResolvedValue(makeOverseer({subscribeToActions})),
    }));
    const subscriber = {
      dup: vi.fn(() => ({[Symbol.dispose]: clientDispose})),
    } as unknown as RpcStub<CybernestActionSubscriber>;

    await expect(session.subscribeToActions(subscriber)).rejects.toThrow("subscription setup failed");
    expect(clientDispose).toHaveBeenCalledOnce();
  });

});
