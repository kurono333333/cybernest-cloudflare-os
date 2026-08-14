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
  ensureCybernestManager: ReturnType<typeof vi.fn>;
  ensureKnowledgeAccount: ReturnType<typeof vi.fn>;
};

const fixture = (boundManagerId = managerId): BridgeFixture => {
  const events: string[] = [];
  const ensureCybernestManager = vi.fn(async (id: string) => {
    events.push("manager:" + id);
  });
  const ensureKnowledgeAccount = vi.fn(async () => {
    events.push("knowledge");
  });
  const user = {
    ensureCybernestManager,
    ensureKnowledgeAccount,
  };
  const assertBoundTo = vi.fn(async (id: string) => {
    events.push("assert:" + id);
    if (id !== boundManagerId) throw new Error("Capability is bound to another Manager.");
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
  return {
    bridge,
    events,
    capability,
    assertBoundTo,
    ensureCybernestManager,
    ensureKnowledgeAccount,
  };
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

  it("rejects a non-stub capability before initializing the User DO", async () => {
    const { bridge, ensureCybernestManager, ensureKnowledgeAccount } = fixture();
    const plainCapability = { assertBoundTo: vi.fn(async () => {}) };

    expect(() =>
      bridge.ensureManagerKnowledge(managerId, plainCapability as never),
    ).toThrow(/expected stub/u);
    expect(plainCapability.assertBoundTo).not.toHaveBeenCalled();
    expect(ensureCybernestManager).not.toHaveBeenCalled();
    expect(ensureKnowledgeAccount).not.toHaveBeenCalled();
  });

  it("rejects a capability bound to another Manager before initializing the User DO", async () => {
    const otherManagerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const {
      bridge,
      capability,
      ensureCybernestManager,
      ensureKnowledgeAccount,
    } = fixture(otherManagerId);

    try {
      await expect(bridge.ensureManagerKnowledge(managerId, capability)).rejects.toThrow(
        "Capability is bound to another Manager.",
      );
      expect(ensureCybernestManager).not.toHaveBeenCalled();
      expect(ensureKnowledgeAccount).not.toHaveBeenCalled();
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
      description: { displayName: "Legacy", singleton: { tsType: "CustomSession" } },
    }, true)).toBe(false);
    expect(isManagerKnowledgeAccount({
      ...record,
      description: { displayName: "Malformed" },
    }, true)).toBe(false);
    expect(isManagerKnowledgeAccount({
      ...record,
      description: { displayName: "Other", singleton: { tsType: "Other" } },
    }, true)).toBe(false);
  });
});
