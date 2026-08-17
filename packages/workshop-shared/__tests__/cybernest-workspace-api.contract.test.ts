import source from "../src/cybernest-workspace-api.ts?raw";
import type { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";

import {
  createCybernestError,
  type CybernestAction,
  type CybernestActionSubscriber,
  type CybernestChatSubscriber,
  type CybernestErrorCode,
  type CybernestMetadataSubscriber,
  type CybernestWorkspaceApi,
  type CybernestWorkspaceSession,
} from "@gadgets/workshop-shared/cybernest-workspace-api";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type RootMethodNames = Extract<keyof CybernestWorkspaceApi, string>;
type SessionMethodNames = Extract<keyof CybernestWorkspaceSession, string>;
type ChatSubscriberMethodNames = Extract<keyof CybernestChatSubscriber, string>;
type ActionSubscriberMethodNames = Extract<keyof CybernestActionSubscriber, string>;
type ErrorCodes = CybernestErrorCode;

type RootSurfaceIsExact = Assert<Equal<
  RootMethodNames,
  "listWorkspaces" | "createWorkspace" | "openWorkspace" | "listOutputs"
>>;
type SessionSurfaceIsExact = Assert<Equal<
  SessionMethodNames,
  | "getMetadata"
  | "subscribeToMetadata"
  | "listModels"
  | "listChats"
  | "getChatHistory"
  | "subscribeToChat"
  | "newChat"
  | "sendChatMessage"
  | "stopAgent"
  | "retryAgent"
  | "listActions"
  | "subscribeToActions"
  | "approveAction"
  | "rejectAction"
>>;
type ChatSubscriberSurfaceIsExact = Assert<Equal<
  ChatSubscriberMethodNames,
  "streamGeneration" | "metadata" | "deleted" | "message" | "stream"
>>;
type ActionSubscriberSurfaceIsExact = Assert<Equal<
  ActionSubscriberMethodNames,
  "entry" | "ready"
>>;
type ErrorCodeSurfaceIsExact = Assert<Equal<
  ErrorCodes,
  | "cybernest.unauthorized"
  | "cybernest.workspace_not_found"
  | "cybernest.invalid_model"
  | "cybernest.blocked_action"
  | "cybernest.invalid_mutation"
  | "cybernest.os_unavailable"
  | "cybernest.unknown_result"
>>;

// Keep the type assertions above live in this test module instead of exporting test-only values.
void (undefined as RootSurfaceIsExact);
void (undefined as SessionSurfaceIsExact);
void (undefined as ChatSubscriberSurfaceIsExact);
void (undefined as ActionSubscriberSurfaceIsExact);
void (undefined as ErrorCodeSurfaceIsExact);

describe("Cybernest Workspace shared contract", () => {
  it("creates only known safe errors", () => {
    const error = createCybernestError("cybernest.blocked_action", "Action is not reviewable.");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("cybernest.blocked_action");
    expect(error.message).toBe("Action is not reviewable.");
  });

  it("keeps native capabilities and unknown-method codes out of the contract source", () => {
    for (const forbidden of [
      "AuthenticatedApi",
      "Overseer",
      "GadgetClient",
      "Gatekeeper",
      "provider",
      "cybernest.forbidden_method",
      "Uint8Array",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("uses pass-by-reference only for the intended nested session and callbacks", () => {
    expect(source).toContain("RpcStub<CybernestWorkspaceSession>");
    expect(source).toContain("CybernestMetadataSubscriber");
    expect(source).toContain("RpcStub<CybernestChatSubscriber>");
    expect(source).toContain("RpcStub<CybernestActionSubscriber>");
    expect(source).not.toContain("RpcStub<AuthenticatedApi>");
    expect(source).not.toContain("RpcStub<Overseer>");
  });

  it("keeps the action projection policy-visible without native payloads", () => {
    const action: CybernestAction = {
      id: 1,
      state: "pending",
      type: "action",
      title: "編集を確認",
      description: "内容を更新します。",
      resourceTitle: "社内ページ",
      createdAt: new Date(0).toISOString(),
      decision: "blocked",
      canApprove: false,
      canReject: true,
      blockedReason: "unknown_action",
    };

    expect(action).not.toHaveProperty("actionKind");
    expect(action).not.toHaveProperty("input");
    expect(action).not.toHaveProperty("provider");
  });

  it("keeps subscription handles opaque and dispose-only", () => {
    const handle: RpcStub<{}> = {} as RpcStub<{}>;
    expect(handle).toBeDefined();
    expect(source).toContain("type CybernestSubscription = RpcStub<{}>");
  });
});

// Ensure the imported RpcTarget types remain part of the compile-time contract and are not
// accidentally replaced with plain serializable objects.
void (undefined as RpcTarget);
void (undefined as RpcStub<{}>);
