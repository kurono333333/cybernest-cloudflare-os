import type { RpcStub, RpcTarget } from "capnweb";

export type CybernestSubscription = RpcStub<{}>;

export interface CybernestWorkspaceApi extends RpcTarget {
  listWorkspaces(): Promise<CybernestWorkspaceSummary[]>;
  createWorkspace(): Promise<RpcStub<CybernestWorkspaceSession>>;
  openWorkspace(id: string): Promise<RpcStub<CybernestWorkspaceSession>>;
  listOutputs(): Promise<CybernestOutputList>;
}

export interface CybernestWorkspaceSession extends RpcTarget {
  getMetadata(): Promise<CybernestWorkspaceMetadata>;
  subscribeToMetadata(callback: CybernestMetadataSubscriber): Promise<CybernestSubscription>;

  listModels(): Promise<CybernestModel[]>;
  listChats(): Promise<CybernestChatMetadata[]>;
  getChatHistory(chatId: number, beforeSequence?: number): Promise<CybernestChatHistoryPage>;
  subscribeToChat(
    subscriber: RpcStub<CybernestChatSubscriber>,
    startAfter?: string,
  ): Promise<CybernestSubscription>;

  newChat(message: string, modelId: string | null): Promise<number>;
  sendChatMessage(chatId: number, message: string, modelId: string | null): Promise<void>;
  stopAgent(chatId: number): Promise<void>;
  retryAgent(chatId: number, modelId: string): Promise<void>;

  listActions(): Promise<CybernestAction[]>;
  subscribeToActions(
    subscriber: RpcStub<CybernestActionSubscriber>,
    startAfter?: string,
  ): Promise<CybernestSubscription>;
  approveAction(id: number): Promise<void>;
  rejectAction(id: number): Promise<void>;
}

export type CybernestAuthor = {
  type: "user" | "agent" | "gadget";
  id: string;
  name: string;
};

export type CybernestWorkspaceSummary = {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string | null;
  lifecycle: "unused" | "active";
  pinned: boolean;
};

export type CybernestWorkspaceMetadata = {
  id: string;
  title: string;
  pinned: boolean;
};

export type CybernestModel = {
  id: string;
  name: string;
};

export type CybernestOutputSummary = {
  workspaceId: string;
  workpieceId: number;
  title: string;
  workspaceTitle: string;
  createdAt: string;
  lastActiveAt: string;
  format?: {
    id: string;
    noun: string;
    plural: string;
  };
};

export type CybernestOutputList = {
  outputs: CybernestOutputSummary[];
  catchingUp: boolean;
};

export type CybernestChatMetadata = {
  id: number;
  title: string;
  startedAt: string;
  lastActiveAt: string;
  active: boolean;
  hasProposedChanges: boolean;
};

export type CybernestToolCall = {
  toolCallId: string;
  output?: string;
  error?: string;
};

export type CybernestChatMessage =
  | {
      kind: "message";
      chatId: number;
      sequence: number;
      timestamp: string;
      author: CybernestAuthor;
      text: string;
      reasoning?: string;
      toolCalls?: CybernestToolCall[];
    }
  | {
      kind: "result";
      chatId: number;
      sequence: number;
      timestamp: string;
      author: CybernestAuthor;
      hasCodeChange: boolean;
      createdWorkpieces: Array<{id: number; title: string}>;
    }
  | {
      kind: "action";
      chatId: number;
      sequence: number;
      timestamp: string;
      author: CybernestAuthor;
      actionId: number;
    }
  | {
      kind: "error";
      chatId: number;
      sequence: number;
      timestamp: string;
      author: CybernestAuthor;
      text: string;
      code?: string;
    }
  | {
      kind: "system";
      chatId: number;
      sequence: number;
      timestamp: string;
      label: string;
      text?: string;
    };

export type CybernestChatHistoryPage = {
  messages: CybernestChatMessage[];
  hasPreviousPage: boolean;
  summary?: string;
};

export type CybernestStreamEvent =
  | {type: "text_delta"; delta: string}
  | {type: "reasoning_delta"; delta: string}
  | {type: "phase"; phase: "compacting" | "compacted" | "tool_started" | "tool_finished"};

export type CybernestMetadataSubscriber = RpcStub<
  (metadata: CybernestWorkspaceMetadata) => void
>;

export interface CybernestChatSubscriber extends RpcTarget {
  streamGeneration(generation: number): void;
  metadata(metadata: CybernestChatMetadata): void;
  deleted(chatId: number): void;
  message(message: CybernestChatMessage): void;
  stream(chatId: number, event: CybernestStreamEvent): void;
}

export interface CybernestActionSubscriber extends RpcTarget {
  entry(action: CybernestAction): void;
  ready(): void;
}

export type CybernestAction = {
  id: number;
  state: "pending" | "approved" | "rejected";
  type: "action" | "observation" | "bindHook";
  title: string;
  description: string;
  resourceTitle: string;
  createdAt: string;
  appliedAt?: string;
  kindLabel?: string;
  decision: "reviewable" | "blocked";
  canApprove: boolean;
  canReject: boolean;
  blockedReason?: "unknown_action" | "high_impact_action" | "not_manual_action";
};

export type CybernestErrorCode =
  | "cybernest.unauthorized"
  | "cybernest.workspace_not_found"
  | "cybernest.invalid_model"
  | "cybernest.blocked_action"
  | "cybernest.invalid_mutation"
  | "cybernest.os_unavailable"
  | "cybernest.unknown_result";

export type CybernestError = Error & {readonly code: CybernestErrorCode};

export const createCybernestError = (
    code: CybernestErrorCode, message: string): CybernestError =>
  Object.assign(new Error(message), {code});
