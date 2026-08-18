import source from "../src/cybernest-workspace-api.ts?raw";
import apiSource from "../src/api.ts?raw";
import type { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";

import {
  createCybernestError,
  type CybernestAction,
  type CybernestActionSubscriber,
  type CybernestChatSubscriber,
  type CybernestConversationCaptureSession,
  type CybernestConversationDraft,
  type CybernestConversationSaveResult,
  type CybernestErrorCode,
  type CybernestWorkspaceApi,
  type CybernestWorkspaceSession,
} from "@gadgets/workshop-shared/cybernest-workspace-api";
import type {
  CybernestConversationCaptureOverseer,
  Overseer,
} from "@gadgets/workshop-shared/api";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

const interfaceBody = (sourceText: string, name: string): string => {
  const match = sourceText.match(
    new RegExp(`export interface ${name}(?: extends [^{]+)? \\{([\\s\\S]*?)\\n\\}`),
  );
  if (match === null) throw new Error(`Missing interface: ${name}`);
  return match[1] ?? "";
};

const interfaceMethodNames = (body: string): string[] =>
  [...body.matchAll(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gmu)].map((match) => match[1] ?? "");

type RootMethodNames = Extract<keyof CybernestWorkspaceApi, string>;
type SessionMethodNames = Extract<keyof CybernestWorkspaceSession, string>;
type ConversationCaptureSessionMethodNames = Extract<
  keyof CybernestConversationCaptureSession,
  string
>;
type ChatSubscriberMethodNames = Extract<keyof CybernestChatSubscriber, string>;
type ActionSubscriberMethodNames = Extract<keyof CybernestActionSubscriber, string>;
type ConversationCaptureMethodNames = Extract<keyof CybernestConversationCaptureOverseer, string>;
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
  | "organizeChat"
  | "saveConversation"
>>;
type ChatSubscriberSurfaceIsExact = Assert<Equal<
  ChatSubscriberMethodNames,
  "streamGeneration" | "metadata" | "deleted" | "message" | "stream"
>>;
type ActionSubscriberSurfaceIsExact = Assert<Equal<
  ActionSubscriberMethodNames,
  "entry" | "ready"
>>;
type ConversationCaptureSurfaceIsExact = Assert<Equal<
  ConversationCaptureSessionMethodNames,
  "organizeChat" | "saveConversation"
>>;
type ConversationCaptureOwnerSurfaceIsExact = Assert<Equal<
  ConversationCaptureMethodNames,
  "organizeChat" | "saveConversation"
>>;
type WorkspaceSessionIncludesConversationCapture = Assert<
  CybernestWorkspaceSession extends CybernestConversationCaptureSession ? true : false
>;
type SessionOrganizeSignatureIsExact = Assert<Equal<
  CybernestConversationCaptureSession["organizeChat"],
  (chatId: number, modelId: string | null) => Promise<CybernestConversationDraft>
>>;
type SessionSaveSignatureIsExact = Assert<Equal<
  CybernestConversationCaptureSession["saveConversation"],
  (chatId: number, draft: CybernestConversationDraft) => Promise<CybernestConversationSaveResult>
>>;
type CaptureSessionIsRpcTarget = Assert<
  CybernestConversationCaptureSession extends RpcTarget ? true : false
>;
type CaptureOwnerIsRpcTarget = Assert<
  CybernestConversationCaptureOverseer extends RpcTarget ? true : false
>;
type ConversationDraftIsExact = Assert<Equal<
  CybernestConversationDraft,
  {
    revisionId: string;
    documentKey: string;
    baseSourceRevisionId: string | null;
    contentHash: string;
    content: string;
  }
>>;
type ConversationSaveResultIsExact = Assert<Equal<
  CybernestConversationSaveResult,
  {
    revisionId: string;
    documentKey: string;
    contentHash: string;
  }
>>;
type OrganizeSignatureIsExact = Assert<Equal<
  CybernestConversationCaptureOverseer["organizeChat"],
  (chatId: number, modelId: string | null) => Promise<CybernestConversationDraft>
>>;
type SaveSignatureIsExact = Assert<Equal<
  CybernestConversationCaptureOverseer["saveConversation"],
  (chatId: number, draft: CybernestConversationDraft) => Promise<CybernestConversationSaveResult>
>>;
type NativeOverseerIncludesConversationCapture = Assert<
  Overseer extends CybernestConversationCaptureOverseer ? true : false
>;
type NativeOverseerCaptureSurfaceIsExact = Assert<Equal<
  Extract<keyof Overseer & CybernestConversationCaptureOverseer, string>,
  "organizeChat" | "saveConversation"
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
void (undefined as ConversationCaptureSurfaceIsExact);
void (undefined as ConversationCaptureOwnerSurfaceIsExact);
void (undefined as WorkspaceSessionIncludesConversationCapture);
void (undefined as SessionOrganizeSignatureIsExact);
void (undefined as SessionSaveSignatureIsExact);
void (undefined as CaptureSessionIsRpcTarget);
void (undefined as CaptureOwnerIsRpcTarget);
void (undefined as ConversationDraftIsExact);
void (undefined as ConversationSaveResultIsExact);
void (undefined as OrganizeSignatureIsExact);
void (undefined as SaveSignatureIsExact);
void (undefined as NativeOverseerIncludesConversationCapture);
void (undefined as NativeOverseerCaptureSurfaceIsExact);
void (undefined as ErrorCodeSurfaceIsExact);

describe("Cybernest Workspace shared contract", () => {
  it("fixes the conversation capture shape without exposing native authority", () => {
    const sessionBody = interfaceBody(source, "CybernestConversationCaptureSession");
    const ownerBody = interfaceBody(apiSource, "CybernestConversationCaptureOverseer");

    expect(interfaceMethodNames(sessionBody)).toEqual(["organizeChat", "saveConversation"]);
    expect(source).toContain("export type CybernestConversationDraft = {");
    expect(source).toContain("export type CybernestConversationSaveResult = {");
    expect(interfaceMethodNames(ownerBody)).toEqual(["organizeChat", "saveConversation"]);
    expect(ownerBody).not.toContain("managerId");
    expect(ownerBody).not.toContain("KnowledgeBase");
  });

  it("integrates capture into the native owner contract and restricted session", () => {
    expect(source).toMatch(
        /export interface CybernestWorkspaceSession extends [^{]*CybernestConversationCaptureSession/u,
    );
    expect(source).not.toContain("CybernestConversationCaptureOverseer");
    expect(apiSource).toMatch(
        /export interface Overseer extends RpcTarget, CybernestConversationCaptureOverseer/u,
    );
  });

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
      "KnowledgeBase",
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
