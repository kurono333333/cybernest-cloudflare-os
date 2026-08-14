import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ManagerKnowledgeBridge } from "../src/server.js";
import { isManagerKnowledgeAccount } from "../src/user.js";

const managerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type BridgeFixture = {
  bridge: ManagerKnowledgeBridge;
  events: string[];
  capability: NativeRpcStub<{ assertBoundTo(id: string): Promise<void> }>;
  assertBoundTo: ReturnType<typeof vi.fn>;
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
  const assertBoundTo = vi.fn(async (id: string) => {
    events.push("assert:" + id);
  });
  const capability = new NativeRpcStub({ assertBoundTo });
  const bridge = Object.create(ManagerKnowledgeBridge.prototype) as ManagerKnowledgeBridge;
  (bridge as unknown as { ctx: unknown }).ctx = {
    exports: {
      UserDurableObject: {
        idFromName: (id: string) => id,
        get: () => user,
      },
    },
  };
  return { bridge, events, capability, assertBoundTo };
};

describe("ManagerKnowledgeBridge", () => {
  it("checks the capability, ensures the Manager, then installs Knowledge", async () => {
    const { bridge, events, capability } = fixture();

    try {
      await bridge.ensureManagerKnowledge(managerId, capability);
      expect(events).toEqual(["assert:" + managerId, "manager:" + managerId, "knowledge"]);
    } finally {
      capability[Symbol.dispose]();
    }
  });

  it("rejects malformed Manager IDs before calling the capability or User DO", async () => {
    const { bridge, capability, assertBoundTo } = fixture();

    try {
      await expect(bridge.ensureManagerKnowledge("not-a-manager", capability)).rejects.toThrow(
        "Manager ID must be a UUID.",
      );
      expect(assertBoundTo).not.toHaveBeenCalled();
    } finally {
      capability[Symbol.dispose]();
    }
  });

  it("recognizes the Manager Knowledge metadata only in private runtime", () => {
    const record = {
      vendorId: "custom",
      autoProvisioned: true,
      description: {
        displayName: "Knowledge Base",
        singleton: { tsType: "KnowledgeBase" },
      },
    };

    expect(isManagerKnowledgeAccount(record, true)).toBe(true);
    expect(isManagerKnowledgeAccount(record, false)).toBe(false);
    expect(isManagerKnowledgeAccount({ ...record, vendorId: "other" }, true)).toBe(false);
    expect(isManagerKnowledgeAccount({ ...record, autoProvisioned: false }, true)).toBe(false);
    expect(isManagerKnowledgeAccount({
      ...record,
      description: { displayName: "Other", singleton: { tsType: "Other" } },
    }, true)).toBe(false);
  });
});
