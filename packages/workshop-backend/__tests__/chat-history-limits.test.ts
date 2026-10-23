import {
  CHAT_HISTORY_ERROR_CODES,
  CHAT_HISTORY_MAX_MESSAGES,
  CHAT_HISTORY_MAX_TEXT_BYTES,
  createChatHistoryError,
  getChatHistoryErrorCode,
  type AiChatMessage,
  type AiChatHistoryPage,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it, vi} from "vitest";
import {
  assertChatHistoryTextBudget,
  buildBoundedChatHistoryPage,
} from "../src/chat-history-limits";

const author = {type: "user" as const, id: "history-user", name: "History User"};

type CodedError = Error & {code?: unknown};

function thrownError(action: () => unknown): CodedError {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected an Error.", {cause: error});
  }
  throw new Error("Expected action to throw.");
}

function message(sequence: number, text = `message-${sequence}`): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp: new Date(sequence),
    author,
    type: "message",
    message: text,
  };
}

describe("bounded native chat history", () => {
  it("keeps an intact 500-message checkpoint page in native order", async () => {
    const records = Array.from(
      {length: CHAT_HISTORY_MAX_MESSAGES},
      (_, index) => message(index + 1),
    );
    const compacted: NonNullable<AiChatHistoryPage["compacted"]> = {
      to: 1,
      summary: "checkpoint summary",
    };
    const hydrate = vi.fn(async (record: AiChatMessage) => record);

    const page = await buildBoundedChatHistoryPage(records, compacted, hydrate);

    expect(page.messages).toEqual(records);
    expect(page.messages[0]).toBe(records[0]);
    expect(page.messages.at(-1)).toBe(records.at(-1));
    expect(page.compacted).toBe(compacted);
    expect(hydrate).toHaveBeenCalledTimes(CHAT_HISTORY_MAX_MESSAGES);
    expect(records).toHaveLength(CHAT_HISTORY_MAX_MESSAGES);
  });

  it("stops after the 501st record and does not hydrate a rejected page", async () => {
    let observed = 0;
    function* records(): Generator<AiChatMessage> {
      for (let index = 0; index < CHAT_HISTORY_MAX_MESSAGES + 20; index += 1) {
        observed += 1;
        yield message(index + 1);
      }
    }
    const hydrate = vi.fn(async (record: AiChatMessage) => record);

    const error = await buildBoundedChatHistoryPage(records(), undefined, hydrate)
      .then(
        () => undefined,
        failure => failure,
      );

    expect(error).toMatchObject({
      code: CHAT_HISTORY_ERROR_CODES.messageLimitExceeded,
      message: "Chat history message limit exceeded.",
    });
    expect(getChatHistoryErrorCode(error)).toBe(
      CHAT_HISTORY_ERROR_CODES.messageLimitExceeded,
    );
    expect(observed).toBe(CHAT_HISTORY_MAX_MESSAGES + 1);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("measures UTF-8 bytes rather than JavaScript string length at the exact boundary", () => {
    const exact = "界".repeat(699_050) + "ab";
    expect(new TextEncoder().encode(exact)).toHaveLength(CHAT_HISTORY_MAX_TEXT_BYTES);
    expect(() => assertChatHistoryTextBudget(exact)).not.toThrow();

    const overByOneByte = exact + "a";
    expect(new TextEncoder().encode(overByOneByte))
      .toHaveLength(CHAT_HISTORY_MAX_TEXT_BYTES + 1);
    expect(thrownError(() => assertChatHistoryTextBudget(overByOneByte))).toMatchObject({
      code: CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
      message: "Chat history text limit exceeded.",
    });
  });

  it("counts nested message text and checkpoint summaries together", () => {
    const withinBudget = {
      messages: [{body: ["a".repeat(CHAT_HISTORY_MAX_TEXT_BYTES - 3), "b"]}],
      compacted: {summary: "cd"},
    };
    expect(() => assertChatHistoryTextBudget(withinBudget)).not.toThrow();

    const overBudget = {
      ...withinBudget,
      compacted: {summary: "cde"},
    };
    expect(thrownError(() => assertChatHistoryTextBudget(overBudget))).toMatchObject({
      code: CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
    });
  });

  it("does not count binary, dates, numbers, or booleans as response text", () => {
    const binary = new Uint8Array(CHAT_HISTORY_MAX_TEXT_BYTES + 1);
    const date = new Date(0);
    const value = {
      binary,
      date,
      number: 42,
      enabled: true,
      nested: ["ok"],
    };

    expect(() => assertChatHistoryTextBudget(value)).not.toThrow();
    expect(value.binary).toBe(binary);
    expect(value.date).toBe(date);
    expect(value.nested).toEqual(["ok"]);
  });

  it("rejects over-budget stored text before hydration", async () => {
    const stored = [message(1, "x".repeat(CHAT_HISTORY_MAX_TEXT_BYTES + 1))];
    const hydrate = vi.fn(async (record: AiChatMessage) => record);

    await expect(
      buildBoundedChatHistoryPage(stored, undefined, hydrate),
    ).rejects.toMatchObject({code: CHAT_HISTORY_ERROR_CODES.textLimitExceeded});
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("rechecks text added by native hydration", async () => {
    const stored = [message(1, "stored")];
    const hydrate = vi.fn(async (record: AiChatMessage): Promise<AiChatMessage> => {
      if (record.type !== "message") return record;
      return {
        ...record,
        reasoning: "x".repeat(CHAT_HISTORY_MAX_TEXT_BYTES),
      };
    });

    await expect(
      buildBoundedChatHistoryPage(stored, undefined, hydrate),
    ).rejects.toMatchObject({code: CHAT_HISTORY_ERROR_CODES.textLimitExceeded});
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("keeps the two stable error causes distinct and ignores unknown failures", () => {
    const countError = createChatHistoryError(
      CHAT_HISTORY_ERROR_CODES.messageLimitExceeded,
    );
    const textError = createChatHistoryError(
      CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
    );

    expect(countError.code).not.toBe(textError.code);
    expect(Object.prototype.propertyIsEnumerable.call(countError, "code")).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(textError, "code")).toBe(true);
    expect(getChatHistoryErrorCode(countError)).toBe(
      CHAT_HISTORY_ERROR_CODES.messageLimitExceeded,
    );
    expect(getChatHistoryErrorCode(textError)).toBe(
      CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
    );
    expect(getChatHistoryErrorCode(new Error("unknown"))).toBeUndefined();
  });

  it("stops cycles but counts a shared object at each response field", () => {
    const shared: {text: string; self?: unknown} = {
      text: "x".repeat(Math.floor(CHAT_HISTORY_MAX_TEXT_BYTES / 2) + 1),
    };
    shared.self = shared;
    const value = {first: shared, second: shared};

    expect(thrownError(() => assertChatHistoryTextBudget(value))).toMatchObject({
      code: CHAT_HISTORY_ERROR_CODES.textLimitExceeded,
    });
    expect(shared.self).toBe(shared);
    expect(value.first).toBe(value.second);
  });
});
