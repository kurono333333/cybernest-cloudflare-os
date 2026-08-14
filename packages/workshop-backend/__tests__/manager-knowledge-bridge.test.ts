import { describe, expect, it, vi } from "vitest";
import { ManagerKnowledgeBridge } from "../src/server.js";

const managerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type BridgeFixture = {
  bridge: ManagerKnowledgeBridge;
  events: string[];
  capability: { assertBoundTo(id: string): Promise<void> };
};

const fixture = (): BridgeFixture => {
  const events: string[] = [];
  const user = {
    ensureCybernestManager: vi.fn(async (id: string) => {
      events.push("manager:" + id);
    }),
    ensureKnowledgeAccount: vi.fn(async () => {
      events.push("knowledge");
    }),
  };
  const capability = {
    assertBoundTo: vi.fn(async (id: string) => {
      events.push("assert:" + id);
    }),
  };
  const bridge = Object.create(ManagerKnowledgeBridge.prototype) as ManagerKnowledgeBridge;
  (bridge as unknown as { ctx: unknown }).ctx = {
    exports: {
      UserDurableObject: {
        idFromName: (id: string) => id,
        get: () => user,
      },
    },
  };
  return { bridge, events, capability };
};

describe("ManagerKnowledgeBridge", () => {
  it("checks the capability, ensures the Manager, then installs Knowledge", async () => {
    const { bridge, events, capability } = fixture();

    await bridge.ensureManagerKnowledge(managerId, capability);

    expect(events).toEqual(["assert:" + managerId, "manager:" + managerId, "knowledge"]);
  });

  it("rejects malformed Manager IDs before calling the capability or User DO", async () => {
    const { bridge, capability } = fixture();

    await expect(bridge.ensureManagerKnowledge("not-a-manager", capability)).rejects.toThrow(
      "Manager ID must be a UUID.",
    );
    expect(capability.assertBoundTo).not.toHaveBeenCalled();
  });
});
