import {existsSync} from "node:fs";
import {describe, expect, it} from "vitest";
import type {Overseer} from "@gadgets/workshop-shared/api";

import apiSource from "../../workshop-shared/src/api.ts?raw";
import sharedPackageSource from "../../workshop-shared/package.json?raw";
import agentSource from "../src/agent.ts?raw";
import overseerSource from "../src/overseer.ts?raw";
import serverSource from "../src/server.ts?raw";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type ForbiddenOverseerMethods = Extract<keyof Overseer, "organizeChat" | "saveConversation">;
type NativeOverseerMethods = Extract<
  keyof Overseer,
  "getMetadata" | "listChats" | "getChatHistory" | "sendChatMessage" | "stopAgent"
>;
type NoConversationCapture = Assert<Equal<ForbiddenOverseerMethods, never>>;
type NativeMethodsRemain = Assert<Equal<
  NativeOverseerMethods,
  "getMetadata" | "listChats" | "getChatHistory" | "sendChatMessage" | "stopAgent"
>>;

void (undefined as NoConversationCapture);
void (undefined as NativeMethodsRemain);

describe("native OS kernel boundary", () => {
  it("does not extend the native shared API with the retired conversation surface", () => {
    expect(apiSource).not.toContain("CybernestConversationCaptureOverseer");
    expect(apiSource).not.toContain("CybernestConversationDraft");
    expect(apiSource).not.toContain("CybernestConversationSaveResult");
    expect(apiSource).not.toMatch(/\borganizeChat\s*\(/u);
    expect(apiSource).not.toMatch(/\bsaveConversation\s*\(/u);
  });

  it("removes the retired shared and backend facade", () => {
    expect(sharedPackageSource).not.toContain("./cybernest-workspace-api");
    expect(
      existsSync(new URL("../../workshop-shared/src/cybernest-workspace-api.ts", import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL("../src/cybernest-workspace-api.ts", import.meta.url)),
    ).toBe(false);
  });

  it("keeps conversation context out of the native agent kernel", () => {
    for (const source of [agentSource, overseerSource]) {
      expect(source).not.toContain("CybernestConversation");
      expect(source).not.toContain("prepareConversationContext");
      expect(source).not.toContain("formatCybernestConversationContextPrompt");
      expect(source).not.toContain("conversationContext");
      expect(source).not.toMatch(/\borganizeChat\s*\(/u);
      expect(source).not.toMatch(/\bsaveConversation\s*\(/u);
    }
  });

  it("keeps the two explicit native integration seams", () => {
    expect(serverSource).toContain("newWebSocketRpcSession");
    expect(overseerSource).toContain("buildBoundedChatHistoryPage");
  });
});
