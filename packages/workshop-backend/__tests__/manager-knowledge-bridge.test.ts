import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ManagerKnowledgeBridge } from "../src/server.js";
import { isManagerKnowledgeAccount } from "../src/user.js";

const managerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type BridgeFixture = {
  bridge: ManagerKnowledgeBridge;
  events: string[];
  capability: NativeRpcStub<{
    assertBoundTo(id: string): Promise<"cybernest-knowledge-read-v1">;
  }>;
  assertBoundTo: ReturnType<typeof vi.fn>;
  inspectManagerKnowledge: ReturnType<typeof vi.fn>;
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
  const inspectManagerKnowledge = vi.fn(async (id: string): Promise<unknown> => {
    events.push("inspect:" + id);
    return {
      ok: true as const,
      value: {
        managerId: id,
        profileReady: true as const,
        provenanceConfirmed: true as const,
        accountState: "absent" as const,
      },
    };
  });
  const user = {
    inspectManagerKnowledge,
    ensureCybernestManager,
    ensureKnowledgeAccount,
  };
  const assertBoundTo = vi.fn(async (id: string) => {
    events.push("assert:" + id);
    if (id !== boundManagerId) throw new Error("Capability is bound to another Manager.");
    return "cybernest-knowledge-read-v1";
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
    inspectManagerKnowledge,
    ensureCybernestManager,
    ensureKnowledgeAccount,
  };
};

type ManagerKnowledgePreflight = {
  managerId: string;
  profileReady: true;
  provenanceConfirmed: true;
  accountState: "absent" | "bound" | "legacy" | "incompatible";
};
type InspectableBridge = ManagerKnowledgeBridge & {
  inspectManagerKnowledge(managerId: string): Promise<
    | { ok: true; value: ManagerKnowledgePreflight }
    | { ok: false; code: "dependency_unavailable" | "permission_denied" }
  >;
};

describe("ManagerKnowledgeBridge", () => {
  it("checks the capability and read-only Manager preflight before installing Knowledge", async () => {
    const { bridge, events, capability, ensureCybernestManager } = fixture();

    try {
      await bridge.ensureManagerKnowledge(managerId, capability);
      expect(events).toContain("inspect:" + managerId);
      expect(events).toContain("assert:" + managerId);
      expect(events.at(-1)).toBe("knowledge");
      expect(events).not.toContain("manager:" + managerId);
      expect(ensureCybernestManager).not.toHaveBeenCalled();
    } finally {
      capability[Symbol.dispose]();
    }
  });

  it("exposes preflight without creating a profile or Knowledge account", async () => {
    const {
      bridge,
      inspectManagerKnowledge,
      ensureCybernestManager,
      ensureKnowledgeAccount,
    } = fixture();

    await expect(
      (bridge as InspectableBridge).inspectManagerKnowledge(managerId),
    ).resolves.toEqual({
      ok: true,
      value: {
        managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "absent",
      },
    });
    expect(inspectManagerKnowledge).toHaveBeenCalledExactlyOnceWith(managerId);
    expect(ensureCybernestManager).not.toHaveBeenCalled();
    expect(ensureKnowledgeAccount).not.toHaveBeenCalled();
  });

  it("does not install Knowledge when preflight reports missing provenance", async () => {
    const { bridge, capability, inspectManagerKnowledge, ensureKnowledgeAccount } = fixture();
    inspectManagerKnowledge.mockResolvedValue({
      ok: false,
      code: "dependency_unavailable",
    });

    try {
      await expect(bridge.ensureManagerKnowledge(managerId, capability)).rejects.toThrow(
        "Manager Knowledge preflight failed: dependency_unavailable.",
      );
      expect(ensureKnowledgeAccount).not.toHaveBeenCalled();
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
    const plainCapability = {
      assertBoundTo: vi.fn(async () => "cybernest-knowledge-read-v1"),
    };

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
