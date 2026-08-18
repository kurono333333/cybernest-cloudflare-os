import { RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  ActionLogEntry,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMetadata,
  AiChatStreamEvent,
  AiChatSubscriber,
  AiChatAuthorInfo,
  AuthenticatedApi,
  GadgetMetadata,
  GadgetMetadataWithTimestamps,
  ListOutputsResult,
  Overseer,
  ActionsSubscriber,
} from "@gadgets/workshop-shared/api";
import {
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import type {
  CybernestAction,
  CybernestActionSubscriber,
  CybernestAuthor,
  CybernestChatHistoryPage,
  CybernestChatMessage,
  CybernestChatMetadata,
  CybernestChatSubscriber,
  CybernestConversationDraft,
  CybernestConversationSaveResult,
  CybernestMetadataSubscriber,
  CybernestModel,
  CybernestOutputList,
  CybernestOutputSummary,
  CybernestStreamEvent,
  CybernestSubscription,
  CybernestWorkspaceApi,
  CybernestWorkspaceMetadata,
  CybernestWorkspaceSession,
  CybernestWorkspaceSummary,
} from "@gadgets/workshop-shared/cybernest-workspace-api";
import { createCybernestError } from "@gadgets/workshop-shared/cybernest-workspace-api";

const REVIEWABLE_ACTION_TAGS = new Set([
  "confluence.editContent",
  "confluence.setTitle",
  "confluence.label",
  "confluence.addComment",
]);

const unknownResult = (message: string): never => {
  throw createCybernestError("cybernest.unknown_result", message);
};

const unavailable = (message: string): never => {
  throw createCybernestError("cybernest.os_unavailable", message);
};

const invalidMutation = (message: string): never => {
  throw createCybernestError("cybernest.invalid_mutation", message);
};

const CONVERSATION_CONTEXT_DOCUMENT_KEY = "conversation-context";
const MAX_CONVERSATION_CONTENT_BYTES = 1_048_576;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SAFE_CAPTURE_ERROR_CODES = new Set([
  "cybernest.unauthorized",
  "cybernest.invalid_model",
  "cybernest.invalid_mutation",
  "cybernest.os_unavailable",
  "cybernest.unknown_result",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  return Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const validConversationText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  !hasUnpairedSurrogate(value) &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_CONTENT_BYTES;

const parseConversationDraft = (
    value: unknown,
    fail: (message: string) => never,
): CybernestConversationDraft => {
  if (!isRecord(value) || !hasExactKeys(value, [
    "baseSourceRevisionId",
    "content",
    "contentHash",
    "documentKey",
    "revisionId",
  ])) {
    return fail("Invalid conversation draft.");
  }
  if (
    typeof value.revisionId !== "string" || !CANONICAL_UUID.test(value.revisionId) ||
    value.documentKey !== CONVERSATION_CONTEXT_DOCUMENT_KEY ||
    (value.baseSourceRevisionId !== null &&
      (typeof value.baseSourceRevisionId !== "string" ||
        !CANONICAL_UUID.test(value.baseSourceRevisionId))) ||
    typeof value.contentHash !== "string" || !SHA256_HEX.test(value.contentHash) ||
    !validConversationText(value.content)
  ) {
    return fail("Invalid conversation draft.");
  }
  return {
    revisionId: value.revisionId,
    documentKey: value.documentKey,
    baseSourceRevisionId: value.baseSourceRevisionId,
    contentHash: value.contentHash,
    content: value.content,
  };
};

const parseConversationSaveResult = (
    value: unknown,
    draft: CybernestConversationDraft,
): CybernestConversationSaveResult => {
  if (!isRecord(value) || !hasExactKeys(value, ["contentHash", "documentKey", "revisionId"])) {
    return unknownResult("Invalid conversation save result.");
  }
  if (
    typeof value.revisionId !== "string" || !CANONICAL_UUID.test(value.revisionId) ||
    value.documentKey !== CONVERSATION_CONTEXT_DOCUMENT_KEY ||
    typeof value.contentHash !== "string" || !SHA256_HEX.test(value.contentHash) ||
    value.revisionId !== draft.revisionId ||
    value.documentKey !== draft.documentKey ||
    value.contentHash !== draft.contentHash
  ) {
    return unknownResult("Invalid conversation save result.");
  }
  return {
    revisionId: value.revisionId,
    documentKey: value.documentKey,
    contentHash: value.contentHash,
  };
};

const captureErrorMessage = (code: string): string => {
  switch (code) {
    case "cybernest.unauthorized": return "Conversation capture is not authorized.";
    case "cybernest.invalid_model": return "Selected model is unavailable.";
    case "cybernest.invalid_mutation": return "Conversation capture request is invalid.";
    case "cybernest.unknown_result": return "Conversation capture returned an invalid result.";
    default: return "Conversation capture is unavailable.";
  }
};

const mapCaptureError = (error: unknown): never => {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code !== undefined && SAFE_CAPTURE_ERROR_CODES.has(code)) {
    throw createCybernestError(code as Parameters<typeof createCybernestError>[0], captureErrorMessage(code));
  }
  return unavailable("Conversation capture is unavailable.");
};

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    return unknownResult(`Invalid ${field}.`);
  }
  return value;
};

const assertFiniteDate = (value: unknown, field: string): string => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return unknownResult(`Invalid ${field}.`);
  }
  return value.toISOString();
};

const assertBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") return unknownResult(`Invalid ${field}.`);
  return value;
};

const assertNonNegativeIntegerResult = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return unknownResult(`Invalid ${field}.`);
  }
  return value;
};

const assertIdentifier = (value: unknown, field: string): string => {
  const result = assertString(value, field);
  if (result.length > 512) return unknownResult(`Invalid ${field}.`);
  return result;
};

const assertNonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    return invalidMutation(`Invalid ${field}.`);
  }
  return value;
};

const parseStartAfter = (value: string | undefined): Date | undefined => {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return invalidMutation("Invalid subscription cursor.");
  return date;
};

const mapAuthor = (author: AiChatAuthorInfo): CybernestAuthor => ({
  type: author.type,
  id: assertIdentifier(author.id, "author id"),
  name: assertString(author.name, "author name"),
});

const mapWorkspaceLifecycle = (value: unknown): "unused" | "active" => {
  if (value === undefined || value === "active") return "active";
  if (value === "unused") return "unused";
  return unknownResult("Invalid workspace lifecycle.");
};

const mapWorkspaceSummary = (metadata: GadgetMetadataWithTimestamps): CybernestWorkspaceSummary => {
  const lifecycle = mapWorkspaceLifecycle(metadata.lifecycle);
  return {
    id: assertIdentifier(metadata.id, "workspace id"),
    title: assertString(metadata.title, "workspace title"),
    createdAt: assertFiniteDate(metadata.created, "workspace created time"),
    lastActiveAt: lifecycle === "unused"
      ? null
      : assertFiniteDate(metadata.lastActive, "workspace activity time"),
    lifecycle,
    pinned: metadata.pinned === undefined ? false : assertBoolean(metadata.pinned, "workspace pinned state"),
  };
};

const mapWorkspaceMetadata = (metadata: GadgetMetadata): CybernestWorkspaceMetadata => ({
  id: assertIdentifier(metadata.id, "workspace id"),
  title: assertString(metadata.title, "workspace title"),
  pinned: metadata.pinned === undefined ? false : assertBoolean(metadata.pinned, "workspace pinned state"),
});

const mapOutput = (output: ListOutputsResult["outputs"][number]): CybernestOutputSummary => ({
  workspaceId: assertIdentifier(output.workspaceId, "output workspace id"),
  workpieceId: assertNonNegativeIntegerResult(output.workpieceId, "output workpiece id"),
  title: assertString(output.title, "output title"),
  workspaceTitle: assertString(output.workspaceTitle, "output workspace title"),
  createdAt: assertFiniteDate(output.created, "output created time"),
  lastActiveAt: assertFiniteDate(output.lastActive, "output activity time"),
  ...(output.output === undefined ? {} : {
    format: {
      id: assertIdentifier(output.output.id, "output format id"),
      noun: assertString(output.output.noun, "output format noun"),
      plural: assertString(output.output.plural, "output format plural"),
    },
  }),
});

const mapOutputs = (result: ListOutputsResult): CybernestOutputList => {
  if (typeof result.catchingUp !== "boolean" || !Array.isArray(result.outputs)) {
    return unknownResult("Invalid output list.");
  }
  return {
    outputs: result.outputs.map(mapOutput),
    catchingUp: result.catchingUp,
  };
};

const mapModel = (model: AiChatAuthorInfo): CybernestModel => ({
  id: assertIdentifier(model.id, "model id"),
  name: assertString(model.name, "model name"),
});

const mapChatMetadata = (metadata: AiChatMetadata): CybernestChatMetadata => ({
  id: assertNonNegativeIntegerResult(metadata.id, "chat id"),
  title: assertString(metadata.title, "chat title"),
  startedAt: assertFiniteDate(metadata.started, "chat start time"),
  lastActiveAt: assertFiniteDate(metadata.lastActive, "chat activity time"),
  active: metadata.activeAgent !== undefined,
  hasProposedChanges: metadata.hasProposedChanges === undefined
    ? false
    : assertBoolean(metadata.hasProposedChanges, "chat proposed changes state"),
});

const mapChatToolCalls = (tools: NonNullable<Extract<AiChatMessage, {type: "message"}>["toolCalls"]>) =>
  tools.map((tool) => {
    const mapped: {toolCallId: string; output?: string; error?: string} = {
      toolCallId: assertIdentifier(tool.toolCallId, "tool call id"),
    };
    if ("output" in tool && typeof tool.output === "string") mapped.output = tool.output;
    if (typeof tool.error === "string") mapped.error = tool.error;
    return mapped;
  });

const fixedSystemMessage = (
    message: AiChatMessage, label: string, text?: string): CybernestChatMessage => ({
  kind: "system",
  chatId: assertNonNegativeIntegerResult(message.chatId, "chat id"),
  sequence: assertNonNegativeIntegerResult(message.sequence, "chat sequence"),
  timestamp: assertFiniteDate(message.timestamp, "chat message time"),
  label,
  ...(text === undefined ? {} : {text}),
});

const mapChatMessage = (message: AiChatMessage): CybernestChatMessage | undefined => {
  const base = {
    chatId: assertNonNegativeIntegerResult(message.chatId, "chat id"),
    sequence: assertNonNegativeIntegerResult(message.sequence, "chat sequence"),
    timestamp: assertFiniteDate(message.timestamp, "chat message time"),
    author: mapAuthor(message.author),
  };

  switch (message.type) {
    case "message":
      return {
        ...base,
        kind: "message",
        text: assertString(message.message, "chat message"),
        ...(message.reasoning === undefined ? {} : {reasoning: assertString(message.reasoning, "chat reasoning")}),
        ...(message.toolCalls === undefined ? {} : {toolCalls: mapChatToolCalls(message.toolCalls)}),
      };
    case "changes":
      return {
        ...base,
        kind: "result",
        hasCodeChange: message.update !== undefined,
        createdWorkpieces: (message.createdGadgets ?? []).map((gadget) => ({
          id: assertNonNegativeIntegerResult(gadget.gadgetId, "created workpiece id"),
          title: assertString(gadget.title, "created workpiece title"),
        })),
      };
    case "action":
      return {
        ...base,
        kind: "action",
        actionId: assertNonNegativeIntegerResult(message.actionId, "action id"),
      };
    case "error":
      return {
        ...base,
        kind: "error",
        text: assertString(message.message, "chat error"),
        ...(message.code === undefined ? {} : {code: assertString(message.code, "chat error code")}),
      };
    case "slashCommand":
      return fixedSystemMessage(message, "スラッシュコマンド");
    case "merge":
      return fixedSystemMessage(message, "変更を反映しました");
    case "revert":
      return fixedSystemMessage(message, "変更を取り消しました");
    case "useGadget":
      return fixedSystemMessage(message, "Workspaceを参照しました");
    case "agentCallback":
      return fixedSystemMessage(message, "Agentから通知がありました");
    case "agentNudge":
      return fixedSystemMessage(message, "Agentを継続しています");
    case "connectionRequest":
      return fixedSystemMessage(message, "外部サービスの接続確認が必要です");
    default:
      return unknownResult("Unknown chat message.");
  }
};

const mapChatHistory = (history: AiChatHistoryPage): CybernestChatHistoryPage => ({
  messages: history.messages.map(mapChatMessage).filter(
    (message): message is CybernestChatMessage => message !== undefined,
  ),
  hasPreviousPage: history.compacted !== undefined,
  ...(history.compacted === undefined ? {} : {summary: assertString(history.compacted.summary, "chat summary")}),
});

const mapStreamEvent = (event: AiChatStreamEvent): CybernestStreamEvent | undefined => {
  switch (event.type) {
    case "compacting":
      return {type: "phase", phase: "compacting"};
    case "compacted":
      return {type: "phase", phase: "compacted"};
    case "textDelta":
      return {type: "text_delta", delta: assertString(event.delta, "text delta")};
    case "reasoningDelta":
      return {type: "reasoning_delta", delta: assertString(event.delta, "reasoning delta")};
    case "toolCallStarted":
      return {type: "phase", phase: "tool_started"};
    case "toolCallFinished":
      return {type: "phase", phase: "tool_finished"};
    case "setActiveFile":
    case "toolCodeDelta":
    case "toolCallTarget":
    case "toolCallOutputFormat":
    case "toolOutputDelta":
    case "codeReset":
    case "codeUpdate":
      return undefined;
    default:
      return undefined;
  }
};

const actionKindFor = (entry: ActionLogEntry) => {
  if (entry.type !== "action") return undefined;
  const kind = entry.description.actionKind;
  if (kind === undefined) return undefined;
  if (typeof kind.tag !== "string" || typeof kind.label !== "string") {
    return unknownResult("Invalid action kind.");
  }
  return kind;
};

const mapAction = (entry: ActionLogEntry): CybernestAction => {
  const kind = actionKindFor(entry);
  const pendingAction = entry.state === "pending" && entry.type === "action";
  const canApprove = pendingAction && kind !== undefined && REVIEWABLE_ACTION_TAGS.has(kind.tag);
  const blockedReason = entry.state !== "pending"
      ? undefined
      : entry.type !== "action"
      ? "not_manual_action"
      : kind === undefined
      ? "unknown_action"
      : canApprove
      ? undefined
      : "high_impact_action";

  return {
    id: assertNonNegativeIntegerResult(entry.id, "action id"),
    state: entry.state,
    type: entry.type,
    title: assertString(entry.description.title, "action title"),
    description: assertString(entry.description.description, "action description"),
    resourceTitle: assertString(entry.resourceTitle, "action resource title"),
    createdAt: assertFiniteDate(entry.createdAt, "action created time"),
    ...(entry.appliedAt === undefined ? {} : {
      appliedAt: assertFiniteDate(entry.appliedAt, "action applied time"),
    }),
    ...(kind === undefined ? {} : {kindLabel: assertString(kind.label, "action kind label")}),
    decision: canApprove ? "reviewable" : "blocked",
    canApprove,
    canReject: pendingAction,
    ...(blockedReason === undefined ? {} : {blockedReason}),
  };
};

const mapActions = (entries: ActionLogEntry[]): CybernestAction[] => entries.map(mapAction);

const mapOpenError = (error: unknown): never => {
  const code = getOpenGadgetErrorCode(error);
  if (code === OPEN_GADGET_ERROR_CODES.workspaceNotFound) {
    throw createCybernestError("cybernest.workspace_not_found", "Workspace not found.");
  }
  if (code === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) {
    throw createCybernestError("cybernest.unauthorized", "Workspace access denied.");
  }
  return unavailable("Workspace service is unavailable.");
};

class MetadataForwarder extends RpcTarget {
  constructor(
      private readonly callback: CybernestMetadataSubscriber,
      private readonly onFailure: () => void,
  ) {
    super();
  }

  update(metadata: GadgetMetadata): void {
    this.callback(mapWorkspaceMetadata(metadata)).catch(this.onFailure);
  }
}

@validateRpc<AiChatSubscriber>()
class ChatForwarder extends RpcTarget implements AiChatSubscriber {
  constructor(
      private readonly subscriber: RpcStub<CybernestChatSubscriber>,
      private readonly onFailure: () => void,
  ) {
    super();
  }

  streamGeneration(generation: number): void {
    this.subscriber.streamGeneration(assertNonNegativeIntegerResult(generation, "stream generation"))
        .catch(this.onFailure);
  }

  metadata(metadata: AiChatMetadata): void {
    this.subscriber.metadata(mapChatMetadata(metadata)).catch(this.onFailure);
  }

  deleted(chatId: number): void {
    this.subscriber.deleted(assertNonNegativeIntegerResult(chatId, "chat id")).catch(this.onFailure);
  }

  message(message: AiChatMessage): void {
    const mapped = mapChatMessage(message);
    if (mapped !== undefined) this.subscriber.message(mapped).catch(this.onFailure);
  }

  draftUpdate(): void {}

  draftCleared(): void {}

  stream(chatId: number, event: AiChatStreamEvent): void {
    const mapped = mapStreamEvent(event);
    if (mapped !== undefined) {
      this.subscriber.stream(assertNonNegativeIntegerResult(chatId, "chat id"), mapped)
          .catch(this.onFailure);
    }
  }
}

@validateRpc<ActionsSubscriber>()
class ActionForwarder extends RpcTarget implements ActionsSubscriber {
  constructor(
      private readonly subscriber: RpcStub<CybernestActionSubscriber>,
      private readonly onFailure: () => void,
  ) {
    super();
  }

  entry(action: ActionLogEntry): void {
    this.subscriber.entry(mapAction(action)).catch(this.onFailure);
  }

  ready(): void {
    this.subscriber.ready().catch(this.onFailure);
  }
}

class SubscriptionDisposeTarget extends RpcTarget {
  constructor(private readonly dispose: () => void) {
    super();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

const disposeOnly = (dispose: () => void): CybernestSubscription =>
  new RpcStub<{}>(new SubscriptionDisposeTarget(dispose));

@validateRpc<CybernestWorkspaceApi>()
export class CybernestWorkspaceApiImpl extends RpcTarget implements CybernestWorkspaceApi {
  constructor(private readonly native: AuthenticatedApi) {
    super();
  }

  async listWorkspaces(): Promise<CybernestWorkspaceSummary[]> {
    return (await this.native.listGadgets()).map(mapWorkspaceSummary);
  }

  async createWorkspace(): Promise<RpcStub<CybernestWorkspaceSession>> {
    return this.#session(await this.native.newGadget());
  }

  async openWorkspace(id: string): Promise<RpcStub<CybernestWorkspaceSession>> {
    id = assertIdentifier(id, "workspace id");
    try {
      return this.#session(await this.native.openGadget(id));
    } catch (error) {
      return mapOpenError(error);
    }
  }

  async listOutputs(): Promise<CybernestOutputList> {
    return mapOutputs(await this.native.listOutputs());
  }

  #session(native: RpcStub<Overseer>): RpcStub<CybernestWorkspaceSession> {
    return new CybernestWorkspaceSessionImpl(native) as unknown as RpcStub<CybernestWorkspaceSession>;
  }
}

@validateRpc<CybernestWorkspaceSession>()
class CybernestWorkspaceSessionImpl extends RpcTarget implements CybernestWorkspaceSession {
  constructor(private readonly native: RpcStub<Overseer>) {
    super();
  }

  async getMetadata(): Promise<CybernestWorkspaceMetadata> {
    return mapWorkspaceMetadata(await this.native.getMetadata());
  }

  async subscribeToMetadata(callback: CybernestMetadataSubscriber): Promise<CybernestSubscription> {
    const clientCallback = callback.dup();
    let nativeSubscription: RpcStub<{}> | undefined;
    let nativeCallback: RpcStub<(metadata: GadgetMetadata) => void> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      nativeSubscription?.[Symbol.dispose]();
      nativeCallback?.[Symbol.dispose]();
      clientCallback[Symbol.dispose]();
    };
    const forwarder = new MetadataForwarder(clientCallback, stop);
    nativeCallback = new RpcStub<(metadata: GadgetMetadata) => void>(
      (metadata) => {
        try {
          forwarder.update(metadata);
        } catch {
          stop();
        }
      },
    );
    try {
      nativeSubscription = await this.native.subscribeToMetadata(nativeCallback);
    } catch (error) {
      stop();
      throw error;
    }
    return disposeOnly(stop);
  }

  async listModels(): Promise<CybernestModel[]> {
    return (await this.native.listModels()).map(mapModel);
  }

  async listChats(): Promise<CybernestChatMetadata[]> {
    return (await this.native.listChats()).map(mapChatMetadata);
  }

  async getChatHistory(chatId: number, beforeSequence?: number): Promise<CybernestChatHistoryPage> {
    chatId = assertNonNegativeInteger(chatId, "chat id");
    if (beforeSequence !== undefined) {
      beforeSequence = assertNonNegativeInteger(beforeSequence, "history cursor");
    }
    return mapChatHistory(await this.native.getChatHistory(chatId, beforeSequence));
  }

  async subscribeToChat(
      subscriber: RpcStub<CybernestChatSubscriber>, startAfter?: string): Promise<CybernestSubscription> {
    const clientSubscriber = subscriber.dup();
    let nativeSubscription: RpcStub<{}> | undefined;
    let nativeSubscriber: RpcStub<AiChatSubscriber> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      nativeSubscription?.[Symbol.dispose]();
      nativeSubscriber?.[Symbol.dispose]();
      clientSubscriber[Symbol.dispose]();
    };
    const forwarder = new ChatForwarder(clientSubscriber, stop);
    nativeSubscriber = new RpcStub<AiChatSubscriber>(forwarder);
    try {
      nativeSubscription = await this.native.subscribeToChat(
          nativeSubscriber, parseStartAfter(startAfter));
    } catch (error) {
      stop();
      throw error;
    }
    return disposeOnly(stop);
  }

  async newChat(message: string, modelId: string | null): Promise<number> {
    await this.#assertModel(modelId);
    return assertNonNegativeInteger(await this.native.newChat(message, modelId), "chat id");
  }

  async sendChatMessage(chatId: number, message: string, modelId: string | null): Promise<void> {
    chatId = assertNonNegativeInteger(chatId, "chat id");
    await this.#assertModel(modelId);
    await this.native.sendChatMessage(chatId, message, modelId);
  }

  async stopAgent(chatId: number): Promise<void> {
    await this.native.stopAgent(assertNonNegativeInteger(chatId, "chat id"));
  }

  async retryAgent(chatId: number, modelId: string): Promise<void> {
    chatId = assertNonNegativeInteger(chatId, "chat id");
    await this.#assertModel(modelId);
    await this.native.retryAgent(chatId, modelId);
  }

  async organizeChat(chatId: number, modelId: string | null): Promise<CybernestConversationDraft> {
    chatId = assertNonNegativeInteger(chatId, "chat id");
    try {
      await this.#assertModel(modelId);
      return parseConversationDraft(await this.native.organizeChat(chatId, modelId), unknownResult);
    } catch (error) {
      return mapCaptureError(error);
    }
  }

  async saveConversation(
      chatId: number, draft: CybernestConversationDraft): Promise<CybernestConversationSaveResult> {
    chatId = assertNonNegativeInteger(chatId, "chat id");
    draft = parseConversationDraft(draft, invalidMutation);
    try {
      return parseConversationSaveResult(
          await this.native.saveConversation(chatId, draft), draft);
    } catch (error) {
      return mapCaptureError(error);
    }
  }

  async listActions(): Promise<CybernestAction[]> {
    return mapActions(await this.native.listActions());
  }

  async subscribeToActions(
      subscriber: RpcStub<CybernestActionSubscriber>, startAfter?: string): Promise<CybernestSubscription> {
    const clientSubscriber = subscriber.dup();
    let nativeSubscription: RpcStub<{}> | undefined;
    let nativeSubscriber: RpcStub<ActionsSubscriber> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      nativeSubscription?.[Symbol.dispose]();
      nativeSubscriber?.[Symbol.dispose]();
      clientSubscriber[Symbol.dispose]();
    };
    const forwarder = new ActionForwarder(clientSubscriber, stop);
    nativeSubscriber = new RpcStub<ActionsSubscriber>(forwarder);
    try {
      nativeSubscription = await this.native.subscribeToActions(
          nativeSubscriber, parseStartAfter(startAfter));
    } catch (error) {
      stop();
      throw error;
    }
    return disposeOnly(stop);
  }

  async approveAction(id: number): Promise<void> {
    const action = await this.#reviewableAction(id);
    await this.native.approveAction(action.id);
  }

  async rejectAction(id: number): Promise<void> {
    const action = await this.#currentAction(id);
    if (action === undefined || action.type !== "action" || action.state !== "pending") {
      throw createCybernestError("cybernest.blocked_action", "Action is not rejectable.");
    }
    await this.native.rejectAction(action.id);
  }

  async #assertModel(modelId: string | null): Promise<void> {
    if (modelId === null) return;
    if (!Array.from(await this.native.listModels()).some(model => model.id === modelId)) {
      throw createCybernestError("cybernest.invalid_model", "Selected model is unavailable.");
    }
  }

  async #currentAction(id: number): Promise<ActionLogEntry | undefined> {
    id = assertNonNegativeInteger(id, "action id");
    return (await this.native.listActions()).find(action => action.id === id);
  }

  async #reviewableAction(id: number): Promise<ActionLogEntry & {type: "action"}> {
    const action = await this.#currentAction(id);
    const kind = action === undefined ? undefined : actionKindFor(action);
    if (
      action === undefined ||
      action.type !== "action" ||
      action.state !== "pending" ||
      kind === undefined ||
      !REVIEWABLE_ACTION_TAGS.has(kind.tag)
    ) {
      throw createCybernestError("cybernest.blocked_action", "Action is not reviewable.");
    }
    return action;
  }
}
