import {
  CHAT_HISTORY_ERROR_CODES,
  CHAT_HISTORY_MAX_MESSAGES,
  CHAT_HISTORY_MAX_TEXT_BYTES,
  createChatHistoryError,
  type AiChatHistoryPage,
  type AiChatMessage,
} from "@gadgets/workshop-shared/api";

const textEncoder = new TextEncoder();

function collectChatHistoryRecords(records: Iterable<AiChatMessage>): AiChatMessage[] {
  const result: AiChatMessage[] = [];
  for (const record of records) {
    if (result.length === CHAT_HISTORY_MAX_MESSAGES) {
      throw createChatHistoryError(CHAT_HISTORY_ERROR_CODES.messageLimitExceeded);
    }
    result.push(record);
  }
  return result;
}

function isNonTextObject(value: object): boolean {
  return value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Verifies the UTF-8 bytes represented by string-valued response fields.
 *
 * Only cycles on the current traversal path are skipped. If two response fields point to the same
 * object, its strings are counted at both field positions because both are part of the response.
 */
export function assertChatHistoryTextBudget(value: unknown): void {
  let bytes = 0;
  const ancestors = new Set<object>();

  function visit(candidate: unknown): void {
    if (typeof candidate === "string") {
      bytes += textEncoder.encode(candidate).byteLength;
      if (bytes > CHAT_HISTORY_MAX_TEXT_BYTES) {
        throw createChatHistoryError(CHAT_HISTORY_ERROR_CODES.textLimitExceeded);
      }
      return;
    }

    if (typeof candidate !== "object" || candidate === null || isNonTextObject(candidate)) {
      return;
    }
    if (ancestors.has(candidate)) return;

    ancestors.add(candidate);
    try {
      for (const nested of Object.values(candidate)) visit(nested);
    } finally {
      ancestors.delete(candidate);
    }
  }

  visit(value);
}

/**
 * Keeps one native checkpoint page atomic while bounding count before hydration and text both
 * before and after native hydration.
 */
export async function buildBoundedChatHistoryPage(
    records: Iterable<AiChatMessage>,
    compacted: AiChatHistoryPage["compacted"],
    hydrate: (record: AiChatMessage) => AiChatMessage | Promise<AiChatMessage>,
): Promise<AiChatHistoryPage> {
  const storedMessages = collectChatHistoryRecords(records);
  const storedPage = compacted === undefined
    ? {messages: storedMessages}
    : {messages: storedMessages, compacted};
  assertChatHistoryTextBudget(storedPage);

  const messages = await Promise.all(storedMessages.map(record => hydrate(record)));
  const page: AiChatHistoryPage = compacted === undefined
    ? {messages}
    : {messages, compacted};
  assertChatHistoryTextBudget(page);
  return page;
}
