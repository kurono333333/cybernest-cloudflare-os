import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ManagerKnowledgeBridge } from "../src/server.js";
import { isManagerKnowledgeAccount } from "../src/user.js";

const GOLD_PAGE_CONTROL_CONTRACT = "cybernest-knowledge-gold-page-control-v1" as const;
const managerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherManagerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type PageControllerBinding = Readonly<{
  assertBoundTo(
    managerId: string,
  ): typeof GOLD_PAGE_CONTROL_CONTRACT | Promise<typeof GOLD_PAGE_CONTROL_CONTRACT>;
  inspectPage(input: unknown): Promise<unknown>;
  admitPageAction(input: unknown): Promise<unknown>;
  editPage(input: unknown): Promise<unknown>;
  requestProtectionReleaseAndCleanReplacement(input: unknown): Promise<unknown>;
}>;

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
  idFromName: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
  ensureManagerKnowledgeGoldRoles: ReturnType<typeof vi.fn>;
  ensureManagerKnowledgeGoldPageRoles: ReturnType<typeof vi.fn>;
};

const fixture = (
  boundManagerId = managerId,
  accountState: "absent" | "bound" = "absent",
): BridgeFixture => {
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
        accountState,
      },
    };
  });
  const ensureManagerKnowledgeGoldRoles = vi.fn(
    async (
      _controller: Parameters<ManagerKnowledgeBridge["ensureManagerKnowledgeGoldRoles"]>[1],
    ) => {
      events.push("gold-job-role:" + boundManagerId);
    },
  );
  const ensureManagerKnowledgeGoldPageRoles = vi.fn(
    async (_controller: NativeRpcStub<PageControllerBinding>) => {
      events.push("gold-page-role:" + boundManagerId);
    },
  );
  const user = {
    inspectManagerKnowledge,
    ensureCybernestManager,
    ensureKnowledgeAccount,
    ensureManagerKnowledgeGoldRoles,
    ensureManagerKnowledgeGoldPageRoles,
  };
  const idFromName = vi.fn((id: string) => id);
  const getUser = vi.fn(() => user);
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
        idFromName,
        get: getUser,
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
    idFromName,
    getUser,
    ensureManagerKnowledgeGoldRoles,
    ensureManagerKnowledgeGoldPageRoles,
  };
};

const pageController = (
  assertion: (
    requestedManagerId: string,
  ) => typeof GOLD_PAGE_CONTROL_CONTRACT | Promise<typeof GOLD_PAGE_CONTROL_CONTRACT>,
  events: string[],
): Readonly<{
  capability: NativeRpcStub<PageControllerBinding>;
  assertBoundTo: ReturnType<typeof vi.fn>;
  inspectPage: ReturnType<typeof vi.fn>;
  admitPageAction: ReturnType<typeof vi.fn>;
  editPage: ReturnType<typeof vi.fn>;
  requestProtectionReleaseAndCleanReplacement: ReturnType<typeof vi.fn>;
}> => {
  const assertBoundTo = vi.fn((requestedManagerId: string) => {
    events.push("page-assert:" + requestedManagerId);
    return assertion(requestedManagerId);
  });
  const inspectPage = vi.fn(async () => {
    throw new Error("Unexpected page inspection during role installation");
  });
  const admitPageAction = vi.fn(async () => {
    throw new Error("Unexpected page action admission during role installation");
  });
  const editPage = vi.fn(async () => {
    throw new Error("Unexpected page edit during role installation");
  });
  const requestProtectionReleaseAndCleanReplacement = vi.fn(async () => {
    throw new Error("Unexpected page replacement during role installation");
  });
  const capability = new NativeRpcStub<PageControllerBinding>({
    assertBoundTo,
    inspectPage,
    admitPageAction,
    editPage,
    requestProtectionReleaseAndCleanReplacement,
  });
  return {
    capability,
    assertBoundTo,
    inspectPage,
    admitPageAction,
    editPage,
    requestProtectionReleaseAndCleanReplacement,
  };
};

const invokePageRoleInstallation = async (
  bridge: ManagerKnowledgeBridge,
  capability: unknown,
): Promise<void> => {
  const operation = Reflect.get(bridge, "ensureManagerKnowledgeGoldPageRoles");
  expect(operation).toBeTypeOf("function");
  await Reflect.apply(operation, bridge, [managerId, capability]);
};

type ManagerKnowledgePreflight = {
  managerId: string;
  profileReady: true;
  provenanceConfirmed: true;
  accountState: "absent" | "bound" | "legacy" | "incompatible";
};
type InspectableBridge = ManagerKnowledgeBridge & {
  inspectManagerKnowledge(
    managerId: string,
  ): Promise<
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
    const { bridge, inspectManagerKnowledge, ensureCybernestManager, ensureKnowledgeAccount } =
      fixture();

    await expect((bridge as InspectableBridge).inspectManagerKnowledge(managerId)).resolves.toEqual(
      {
        ok: true,
        value: {
          managerId,
          profileReady: true,
          provenanceConfirmed: true,
          accountState: "absent",
        },
      },
    );
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

    expect(() => bridge.ensureManagerKnowledge(managerId, plainCapability as never)).toThrow(
      /expected stub/u,
    );
    expect(plainCapability.assertBoundTo).not.toHaveBeenCalled();
    expect(ensureCybernestManager).not.toHaveBeenCalled();
    expect(ensureKnowledgeAccount).not.toHaveBeenCalled();
  });

  it("rejects a capability bound to another Manager before initializing the User DO", async () => {
    const otherManagerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { bridge, capability, ensureCybernestManager, ensureKnowledgeAccount } =
      fixture(otherManagerId);

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

  it("installs only the bound page controller after canonical User and account preflight", async () => {
    const {
      bridge,
      events,
      ensureManagerKnowledgeGoldPageRoles,
      getUser,
      idFromName,
      inspectManagerKnowledge,
    } = fixture(managerId, "bound");
    const page = pageController(async (requestedManagerId) => {
      expect(requestedManagerId).toBe(managerId);
      return GOLD_PAGE_CONTROL_CONTRACT;
    }, events);

    try {
      await invokePageRoleInstallation(bridge, page.capability);

      expect(events).toEqual([
        "page-assert:" + managerId,
        "inspect:" + managerId,
        "gold-page-role:" + managerId,
      ]);
      expect(inspectManagerKnowledge).toHaveBeenCalledExactlyOnceWith(managerId);
      expect(idFromName).toHaveBeenCalledExactlyOnceWith(managerId);
      expect(getUser).toHaveBeenCalledExactlyOnceWith(managerId);
      expect(ensureManagerKnowledgeGoldPageRoles).toHaveBeenCalledExactlyOnceWith(page.capability);
      expect(page.assertBoundTo).toHaveBeenCalledExactlyOnceWith(managerId);
      expect(page.inspectPage).not.toHaveBeenCalled();
      expect(page.admitPageAction).not.toHaveBeenCalled();
      expect(page.editPage).not.toHaveBeenCalled();
      expect(page.requestProtectionReleaseAndCleanReplacement).not.toHaveBeenCalled();
    } finally {
      page.capability[Symbol.dispose]();
    }
  });

  it("rejects the job-control marker when a page-control capability is required", async () => {
    const { bridge, events, inspectManagerKnowledge, ensureManagerKnowledgeGoldPageRoles } =
      fixture(managerId, "bound");
    const jobController = new NativeRpcStub({
      assertBoundTo: vi.fn(async (requestedManagerId: string) => {
        events.push("job-assert:" + requestedManagerId);
        return "cybernest-knowledge-gold-job-control-v1" as const;
      }),
      inspect: vi.fn(async () => {
        throw new Error("Unexpected job inspection");
      }),
      apply: vi.fn(async () => {
        throw new Error("Unexpected job action");
      }),
    });

    try {
      await expect(invokePageRoleInstallation(bridge, jobController)).rejects.toThrow();
      expect(events).toEqual(["job-assert:" + managerId]);
      expect(inspectManagerKnowledge).not.toHaveBeenCalled();
      expect(ensureManagerKnowledgeGoldPageRoles).not.toHaveBeenCalled();
    } finally {
      jobController[Symbol.dispose]();
    }
  });

  it("rejects a page capability bound to another Manager before User preflight", async () => {
    const { bridge, events, inspectManagerKnowledge, ensureManagerKnowledgeGoldPageRoles } =
      fixture(managerId, "bound");
    const page = pageController(async (requestedManagerId) => {
      if (requestedManagerId !== otherManagerId) {
        throw new Error("Capability is bound to another Manager.");
      }
      return GOLD_PAGE_CONTROL_CONTRACT;
    }, events);

    try {
      await expect(invokePageRoleInstallation(bridge, page.capability)).rejects.toThrow(
        "Capability is bound to another Manager.",
      );
      expect(events).toEqual(["page-assert:" + managerId]);
      expect(inspectManagerKnowledge).not.toHaveBeenCalled();
      expect(ensureManagerKnowledgeGoldPageRoles).not.toHaveBeenCalled();
    } finally {
      page.capability[Symbol.dispose]();
    }
  });

  it("does not install page control when the canonical User account is missing", async () => {
    const { bridge, events, inspectManagerKnowledge, ensureManagerKnowledgeGoldPageRoles } =
      fixture(managerId, "absent");
    const page = pageController(async () => GOLD_PAGE_CONTROL_CONTRACT, events);

    try {
      await expect(invokePageRoleInstallation(bridge, page.capability)).rejects.toThrow(
        "Manager Knowledge preflight failed: dependency_unavailable.",
      );
      expect(events).toEqual(["page-assert:" + managerId, "inspect:" + managerId]);
      expect(inspectManagerKnowledge).toHaveBeenCalledExactlyOnceWith(managerId);
      expect(ensureManagerKnowledgeGoldPageRoles).not.toHaveBeenCalled();
    } finally {
      page.capability[Symbol.dispose]();
    }
  });

  it("does not promote the job role into page control", async () => {
    const { bridge, events, ensureManagerKnowledgeGoldRoles, ensureManagerKnowledgeGoldPageRoles } =
      fixture(managerId, "bound");
    const jobController = new NativeRpcStub({
      assertBoundTo: vi.fn(async (requestedManagerId: string) => {
        events.push("job-assert:" + requestedManagerId);
        return "cybernest-knowledge-gold-job-control-v1" as const;
      }),
      inspect: vi.fn(async () => ({})),
      apply: vi.fn(async () => ({})),
    });

    try {
      await bridge.ensureManagerKnowledgeGoldRoles(managerId, jobController);

      expect(events).toEqual([
        "job-assert:" + managerId,
        "inspect:" + managerId,
        "gold-job-role:" + managerId,
      ]);
      expect(ensureManagerKnowledgeGoldRoles).toHaveBeenCalledExactlyOnceWith(jobController);
      expect(ensureManagerKnowledgeGoldPageRoles).not.toHaveBeenCalled();
    } finally {
      jobController[Symbol.dispose]();
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
    expect(
      isManagerKnowledgeAccount(
        {
          ...record,
          description: { displayName: "Legacy", singleton: { tsType: "CustomSession" } },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isManagerKnowledgeAccount(
        {
          ...record,
          description: { displayName: "Malformed" },
        },
        true,
      ),
    ).toBe(false);
    expect(
      isManagerKnowledgeAccount(
        {
          ...record,
          description: { displayName: "Other", singleton: { tsType: "Other" } },
        },
        true,
      ),
    ).toBe(false);
  });
});
