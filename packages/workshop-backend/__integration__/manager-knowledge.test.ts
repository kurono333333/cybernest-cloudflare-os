import { env, exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  GOLD_CONTROL_CONTRACT,
  GOLD_PAGE_CONTROL_CONTRACT,
  type ManagerKnowledgeCapability,
} from "./manager-knowledge-worker.js";

type ManagerKnowledgeBridge = {
  inspectManagerKnowledge(managerId: string): Promise<
    | {
        ok: true;
        value: {
          managerId: string;
          profileReady: true;
          provenanceConfirmed: true;
          accountState: "absent" | "bound" | "legacy" | "incompatible";
        };
      }
    | { ok: false; code: "dependency_unavailable" | "permission_denied" }
  >;
  ensureManagerKnowledge(managerId: string, capability: ManagerKnowledgeCapability): Promise<void>;
};

type ManagerKnowledgeUser = {
  ensureCybernestManager(managerId: string): Promise<void>;
  whoamiIfExists(): Promise<{ type: "user"; name: string; id: string } | null>;
  ensureKnowledgeAccount(capability: ManagerKnowledgeCapability): Promise<void>;
  ensureManagerKnowledgeGoldPageRoles(
    controller: ReturnType<typeof goldPageController>["controller"],
  ): Promise<void>;
  createAccount(
    username: string,
    displayName: string,
    passwordHash: Uint8Array,
  ): Promise<string | null>;
  connectAccount(vendorId: string): Promise<{ url: string }>;
  putConnectedAccount(record: {
    id: number;
    account: object;
    description: { displayName: string; url: string; singleton?: { tsType?: string } };
    vendorId: string;
    autoProvisioned?: boolean;
  }): Promise<void>;
  listProvidedAccounts(): Promise<
    Array<{
      accountId: number;
      vendorId: string;
      description: { singleton?: { tsType?: string } };
    }>
  >;
  disconnectAccount(accountId: number): Promise<void>;
  subscribeConnectedAccounts(
    subscriber: RpcStub<ConnectedAccountsSubscriber>,
  ): Promise<RpcStub<Record<string, never>>>;
};

type ConnectedAccountsSubscriber = {
  add(id: number): void;
  remove(id: number): void;
  ready(): void;
};

type CapabilityFactory = {
  create(managerId: string): Promise<ManagerKnowledgeCapability>;
  captureBridgeEnsure(managerId: string): Promise<string | null>;
  resetAccountCreations(): Promise<void>;
  readAccountCreations(): Promise<number>;
  readGoldRoleStateForTest(managerId: string): Promise<{
    goldJobRole: "absent" | "installed";
    goldPageRole: "absent" | "installed";
    pageSlotEvents: string[];
    jobSlotEvents: string[];
  }>;
};

const goldPageController = (managerId: string, contract: string = GOLD_PAGE_CONTROL_CONTRACT) => {
  const assertedManagerIds: string[] = [];
  const controller = new NativeRpcStub({
    assertBoundTo: async (requestedManagerId) => {
      assertedManagerIds.push(requestedManagerId);
      if (requestedManagerId !== managerId)
        throw new Error("Controller is bound to another Manager.");
      // The job-contract value is intentional in the foreign-marker case.
      return contract as typeof GOLD_PAGE_CONTROL_CONTRACT;
    },
    inspectPage: async () => {
      throw new Error("Unexpected page inspection during role installation.");
    },
    admitPageAction: async () => {
      throw new Error("Unexpected page action during role installation.");
    },
    editPage: async () => {
      throw new Error("Unexpected page edit during role installation.");
    },
    requestProtectionReleaseAndCleanReplacement: async () => {
      throw new Error("Unexpected page replacement during role installation.");
    },
  });
  return { controller, assertedManagerIds };
};

class RecordingConnectedAccountsSubscriber extends RpcTarget {
  readonly added: number[] = [];

  add(id: number): void {
    this.added.push(id);
  }

  remove(_id: number): void {}

  ready(): void {}
}

const capabilityFactory = (): CapabilityFactory =>
  (env as unknown as { MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: CapabilityFactory })
    .MANAGER_KNOWLEDGE_CAPABILITY_FACTORY;

const userKnowledgeStorageSnapshot = async (
  user: DurableObjectStub<ManagerKnowledgeUser>,
): Promise<{
  created: boolean;
  profile: unknown;
  proofMarker: unknown;
  nextAccountId: number;
  firstAccount: unknown;
  secondAccount: unknown;
}> =>
  runInDurableObject(user, async (instance) => {
    const target = instance as unknown as {
      storage: {
        created: { get(): boolean };
        profile: { get(): unknown };
        cybernestManagerProofManagerId?: { get(): string | null };
        nextAccountId: { get(): number };
        connectedAccounts: { get(id: number): unknown };
      };
    };
    const storage = target.storage;
    const accountSnapshot = (value: unknown) => {
      if (value === undefined) return undefined;
      const record = value as {
        id: number;
        vendorId: string;
        description: unknown;
        autoProvisioned?: boolean;
      };
      return {
        id: record.id,
        vendorId: record.vendorId,
        description: record.description,
        autoProvisioned: record.autoProvisioned,
      };
    };
    return {
      created: storage.created.get(),
      profile: storage.profile.get(),
      proofMarker: storage.cybernestManagerProofManagerId?.get(),
      nextAccountId: storage.nextAccountId.get(),
      firstAccount: accountSnapshot(storage.connectedAccounts.get(0)),
      secondAccount: accountSnapshot(storage.connectedAccounts.get(1)),
    };
  });

const seedProofBackedManagerForTest = async (
  user: DurableObjectStub<ManagerKnowledgeUser>,
  managerId: string,
): Promise<void> => {
  await user.ensureCybernestManager(managerId);
  await runInDurableObject(user, async (instance) => {
    const target = instance as unknown as {
      ctx: { storage: { kv: { put(key: string, value: unknown): void } } };
    };
    target.ctx.storage.kv.put("cybernestManagerProofManagerId", managerId);
  });
};

const hasManagerKnowledgeGoldPageRoleApi = async (
  user: DurableObjectStub<ManagerKnowledgeUser>,
): Promise<boolean> =>
  runInDurableObject(
    user,
    (instance) =>
      typeof Reflect.get(instance, "ensureManagerKnowledgeGoldPageRoles") === "function",
  );

const connectRecordingKnowledgeAccount = async (
  user: DurableObjectStub<ManagerKnowledgeUser>,
  managerId: string,
): Promise<void> => {
  await seedProofBackedManagerForTest(user, managerId);
  await user.connectAccount("custom");
  await runInDurableObject(user, async (instance) => {
    const target = instance as unknown as ManagerKnowledgeUser & {
      ctx: {
        exports: {
          ManagerKnowledgeTestCapability(input: {
            props: { managerId: string };
          }): ManagerKnowledgeCapability;
          ManagerKnowledgeTestAccount(input: {
            props: { capability: ManagerKnowledgeCapability };
          }): {
            describe(): Promise<{
              displayName: string;
              avatar: { url: string };
              singleton: { tsType: string };
            }>;
          };
        };
      };
    };
    const capability = target.ctx.exports.ManagerKnowledgeTestCapability({
      props: { managerId },
    });
    const account = target.ctx.exports.ManagerKnowledgeTestAccount({
      props: { capability },
    });
    const description = await account.describe();
    await target.putConnectedAccount({
      id: 0,
      account,
      description: {
        displayName: description.displayName,
        url: "knowledge://test",
        singleton: description.singleton,
      },
      vendorId: "custom",
      autoProvisioned: true,
    });
  });
};

describe("Cybernest Manager Knowledge bridge", () => {
  it("fails closed for missing or profile-only state without changing either one", async () => {
    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;

    const missingManagerId = crypto.randomUUID();
    const missingUser = userNamespace.get(userNamespace.idFromName(missingManagerId));
    const missingBefore = await userKnowledgeStorageSnapshot(missingUser);
    await expect(bridge.inspectManagerKnowledge(missingManagerId)).resolves.toEqual({
      ok: false,
      code: "dependency_unavailable",
    });
    await expect(missingUser.whoamiIfExists()).resolves.toBeNull();
    await expect(userKnowledgeStorageSnapshot(missingUser)).resolves.toEqual(missingBefore);

    const profileOnlyManagerId = crypto.randomUUID();
    const profileOnlyUser = userNamespace.get(userNamespace.idFromName(profileOnlyManagerId));
    await profileOnlyUser.ensureCybernestManager(profileOnlyManagerId);
    const profileOnlyState = await userKnowledgeStorageSnapshot(profileOnlyUser);
    await expect(bridge.inspectManagerKnowledge(profileOnlyManagerId)).resolves.toEqual({
      ok: false,
      code: "dependency_unavailable",
    });
    await expect(profileOnlyUser.whoamiIfExists()).resolves.toMatchObject({
      id: profileOnlyManagerId,
    });
    await expect(userKnowledgeStorageSnapshot(profileOnlyUser)).resolves.toEqual(profileOnlyState);
  });

  it("fails closed on a malformed account cursor without changing state or creating an account", async () => {
    const managerId = crypto.randomUUID();
    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const user = userNamespace.get(userNamespace.idFromName(managerId));
    const factory = capabilityFactory();
    await factory.resetAccountCreations();
    await seedProofBackedManagerForTest(user, managerId);
    await runInDurableObject(user, async (instance) => {
      const target = instance as unknown as {
        storage: { nextAccountId: { put(value: number): void } };
      };
      target.storage.nextAccountId.put(-1);
    });
    const before = await userKnowledgeStorageSnapshot(user);
    await factory.create(managerId);

    await expect(bridge.inspectManagerKnowledge(managerId)).resolves.toEqual({
      ok: false,
      code: "dependency_unavailable",
    });
    await expect(factory.captureBridgeEnsure(managerId)).resolves.toBe(
      "Manager Knowledge preflight failed: dependency_unavailable.",
    );
    await expect(userKnowledgeStorageSnapshot(user)).resolves.toEqual(before);
    await expect(factory.readAccountCreations()).resolves.toBe(0);
  });

  it("installs one persisted Knowledge singleton for a proof-marked Manager and reuses it", async () => {
    const managerId = crypto.randomUUID();
    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const factory = capabilityFactory();
    await factory.resetAccountCreations();
    const capability = await factory.create(managerId);

    const user = userNamespace.get(userNamespace.idFromName(managerId));
    await seedProofBackedManagerForTest(user, managerId);
    const profile = await user.whoamiIfExists();
    expect(profile).toEqual({ type: "user", name: "Manager", id: managerId });
    await expect(bridge.inspectManagerKnowledge(managerId)).resolves.toEqual({
      ok: true,
      value: {
        managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "absent",
        bronzeRoles: { sourceReader: "absent", writer: "absent" },
      },
    });
    await expect(factory.readAccountCreations()).resolves.toBe(0);

    await Promise.all(
      Array.from({ length: 8 }, () => bridge.ensureManagerKnowledge(managerId, capability)),
    );

    const accounts = await user.listProvidedAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      vendorId: "custom",
      description: { singleton: { tsType: "KnowledgeBase" } },
    });
    await expect(factory.readAccountCreations()).resolves.toBe(1);

    const disconnectError = await runInDurableObject(user, async (instance) => {
      try {
        await (instance as unknown as ManagerKnowledgeUser).disconnectAccount(
          accounts[0]!.accountId,
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(disconnectError).toBe(
      "The Manager Knowledge account is owned by the Manager and can't be disconnected.",
    );
    await evictDurableObject(user);
    await bridge.ensureManagerKnowledge(managerId, capability);

    await expect(user.listProvidedAccounts()).resolves.toEqual(accounts);
    await expect(factory.readAccountCreations()).resolves.toBe(1);

    const subscriberTarget = new RecordingConnectedAccountsSubscriber();
    const subscriber = new RpcStub<ConnectedAccountsSubscriber>(subscriberTarget);
    const unsubscribe = await user.subscribeConnectedAccounts(subscriber);
    try {
      expect(subscriberTarget.added).toEqual([]);
    } finally {
      unsubscribe[Symbol.dispose]();
      subscriber[Symbol.dispose]();
    }
  });

  it("rejects a Gold job controller at the page-role boundary without touching either role slot", async () => {
    const managerId = crypto.randomUUID();
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const user = userNamespace.get(userNamespace.idFromName(managerId));
    const factory = capabilityFactory();
    const controller = goldPageController(managerId, GOLD_CONTROL_CONTRACT);
    await connectRecordingKnowledgeAccount(user, managerId);
    const before = await userKnowledgeStorageSnapshot(user);

    try {
      expect(await hasManagerKnowledgeGoldPageRoleApi(user)).toBe(true);
      await expect(user.ensureManagerKnowledgeGoldPageRoles(controller.controller)).rejects.toThrow(
        "Manager Knowledge integrity_failure: incompatible Gold controller contract.",
      );

      expect(controller.assertedManagerIds).toEqual([managerId]);
      await expect(factory.readGoldRoleStateForTest(managerId)).resolves.toEqual({
        goldJobRole: "absent",
        goldPageRole: "absent",
        pageSlotEvents: [],
        jobSlotEvents: [],
      });
      await expect(userKnowledgeStorageSnapshot(user)).resolves.toEqual(before);
    } finally {
      controller.controller[Symbol.dispose]();
    }
  });

  it("installs, reads back, and reuses the separate page-role slot on retry", async () => {
    const managerId = crypto.randomUUID();
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const user = userNamespace.get(userNamespace.idFromName(managerId));
    const factory = capabilityFactory();
    const controller = goldPageController(managerId);
    await connectRecordingKnowledgeAccount(user, managerId);
    const before = await userKnowledgeStorageSnapshot(user);

    try {
      expect(await hasManagerKnowledgeGoldPageRoleApi(user)).toBe(true);
      await user.ensureManagerKnowledgeGoldPageRoles(controller.controller);

      await expect(factory.readGoldRoleStateForTest(managerId)).resolves.toEqual({
        goldJobRole: "absent",
        goldPageRole: "installed",
        pageSlotEvents: ["inspect:" + managerId, "install:" + managerId, "inspect:" + managerId],
        jobSlotEvents: [],
      });
      expect(controller.assertedManagerIds.length).toBeGreaterThan(0);
      expect(controller.assertedManagerIds.every((id) => id === managerId)).toBe(true);
      await expect(userKnowledgeStorageSnapshot(user)).resolves.toEqual(before);

      await user.ensureManagerKnowledgeGoldPageRoles(controller.controller);

      await expect(factory.readGoldRoleStateForTest(managerId)).resolves.toEqual({
        goldJobRole: "absent",
        goldPageRole: "installed",
        pageSlotEvents: [
          "inspect:" + managerId,
          "install:" + managerId,
          "inspect:" + managerId,
          "inspect:" + managerId,
          "inspect:" + managerId,
        ],
        jobSlotEvents: [],
      });
      await expect(userKnowledgeStorageSnapshot(user)).resolves.toEqual(before);
    } finally {
      controller.controller[Symbol.dispose]();
    }
  });

  it("keeps ensure fail-closed for missing, invalid, or unreadable User state", async () => {
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const factory = capabilityFactory();
    await factory.resetAccountCreations();

    const missingManagerId = crypto.randomUUID();
    const missingUser = userNamespace.get(userNamespace.idFromName(missingManagerId));
    const missingCapability = await factory.create(missingManagerId);
    const missingError = await runInDurableObject(missingUser, async (instance) => {
      try {
        await (instance as unknown as ManagerKnowledgeUser).ensureKnowledgeAccount(
          missingCapability,
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(missingError).toContain("User profile is missing");

    const invalidManagerId = crypto.randomUUID();
    const invalidUser = userNamespace.get(userNamespace.idFromName(invalidManagerId));
    await invalidUser.createAccount("not-a-manager", "Invalid", new Uint8Array([1]));
    const invalidCapability = await factory.create(invalidManagerId);
    const invalidError = await runInDurableObject(invalidUser, async (instance) => {
      try {
        await (instance as unknown as ManagerKnowledgeUser).ensureKnowledgeAccount(
          invalidCapability,
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(invalidError).toContain("User profile is not a Manager");

    const unreadableManagerId = crypto.randomUUID();
    const unreadableUser = userNamespace.get(userNamespace.idFromName(unreadableManagerId));
    await seedProofBackedManagerForTest(unreadableUser, unreadableManagerId);
    const unreadableError = await runInDurableObject(unreadableUser, async (instance) => {
      const target = instance as unknown as ManagerKnowledgeUser & {
        ctx: {
          exports: {
            ManagerKnowledgeTestCapability(input: {
              props: { managerId: string };
            }): ManagerKnowledgeCapability;
          };
        };
        storage: {
          nextAccountId: { put(value: number): void };
          connectedAccounts: {
            get(id: number): unknown;
          };
        };
      };
      const unreadableCapability = target.ctx.exports.ManagerKnowledgeTestCapability({
        props: { managerId: unreadableManagerId },
      });
      target.storage.nextAccountId.put(1);
      const originalGet = target.storage.connectedAccounts.get;
      target.storage.connectedAccounts.get = (id) => {
        if (id === 0) throw new Error("unreadable test slot");
        return originalGet.call(target.storage.connectedAccounts, id);
      };
      try {
        await target.ensureKnowledgeAccount(unreadableCapability);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        target.storage.connectedAccounts.get = originalGet;
        (unreadableCapability as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
      }
    });
    expect(unreadableError).toContain("unreadable connected account");
    await expect(factory.readAccountCreations()).resolves.toBe(0);
  });

  it("keeps legacy and duplicate Custom slots when installation fails closed", async () => {
    const managerId = crypto.randomUUID();
    const userNamespace = (
      exports as unknown as {
        UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
      }
    ).UserDurableObject;
    const user = userNamespace.get(userNamespace.idFromName(managerId));
    await seedProofBackedManagerForTest(user, managerId);
    const vendor = (
      env as unknown as {
        GATEKEEPER_CUSTOM: {
          createLegacyAccount(): Promise<object>;
        };
      }
    ).GATEKEEPER_CUSTOM;
    const legacyDescription = {
      displayName: "Custom Gatekeeper",
      url: "custom://deployment-info",
      singleton: { tsType: "CustomSession" },
    };

    await user.connectAccount("custom");
    await user.putConnectedAccount({
      id: 0,
      account: await vendor.createLegacyAccount(),
      description: legacyDescription,
      vendorId: "custom",
      autoProvisioned: true,
    });

    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const factory = capabilityFactory();
    await factory.resetAccountCreations();
    await factory.create(managerId);
    const legacySnapshot = await userKnowledgeStorageSnapshot(user);

    await expect(bridge.inspectManagerKnowledge(managerId)).resolves.toEqual({
      ok: true,
      value: {
        managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "legacy",
        bronzeRoles: { sourceReader: "absent", writer: "absent" },
      },
    });
    await expect(factory.captureBridgeEnsure(managerId)).resolves.toBe(
      "Manager Knowledge preflight failed: dependency_unavailable.",
    );
    const directLegacyError = await runInDurableObject(user, async (instance) => {
      const target = instance as unknown as ManagerKnowledgeUser & {
        ctx: {
          exports: {
            ManagerKnowledgeTestCapability(input: {
              props: { managerId: string };
            }): ManagerKnowledgeCapability;
          };
        };
      };
      const directCapability = target.ctx.exports.ManagerKnowledgeTestCapability({
        props: { managerId },
      });
      try {
        await target.ensureKnowledgeAccount(directCapability);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        (directCapability as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
      }
    });
    expect(directLegacyError).toBe(
      "Manager Knowledge integrity_failure: legacy connected account is not replaceable.",
    );
    await expect(userKnowledgeStorageSnapshot(user)).resolves.toEqual(legacySnapshot);
    await expect(factory.readAccountCreations()).resolves.toBe(0);

    const duplicateManagerId = crypto.randomUUID();
    const duplicateUser = userNamespace.get(userNamespace.idFromName(duplicateManagerId));
    await seedProofBackedManagerForTest(duplicateUser, duplicateManagerId);
    await duplicateUser.connectAccount("custom");
    await duplicateUser.connectAccount("custom");
    await duplicateUser.putConnectedAccount({
      id: 0,
      account: await vendor.createLegacyAccount(),
      description: legacyDescription,
      vendorId: "custom",
      autoProvisioned: true,
    });
    await duplicateUser.putConnectedAccount({
      id: 1,
      account: await vendor.createLegacyAccount(),
      description: legacyDescription,
      vendorId: "custom",
      autoProvisioned: true,
    });
    await factory.create(duplicateManagerId);
    const duplicateSnapshot = await userKnowledgeStorageSnapshot(duplicateUser);
    await expect(bridge.inspectManagerKnowledge(duplicateManagerId)).resolves.toEqual({
      ok: false,
      code: "dependency_unavailable",
    });
    await expect(factory.captureBridgeEnsure(duplicateManagerId)).resolves.toBe(
      "Manager Knowledge preflight failed: dependency_unavailable.",
    );
    const duplicateError = await runInDurableObject(duplicateUser, async (instance) => {
      const target = instance as unknown as ManagerKnowledgeUser & {
        ctx: {
          exports: {
            ManagerKnowledgeTestCapability(input: {
              props: { managerId: string };
            }): ManagerKnowledgeCapability;
          };
        };
      };
      const directCapability = target.ctx.exports.ManagerKnowledgeTestCapability({
        props: { managerId: duplicateManagerId },
      });
      try {
        await target.ensureKnowledgeAccount(directCapability);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        (directCapability as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
      }
    });
    expect(duplicateError).toBe(
      "Manager Knowledge integrity_failure: duplicate connected account.",
    );
    await expect(userKnowledgeStorageSnapshot(duplicateUser)).resolves.toEqual(duplicateSnapshot);
    await expect(factory.readAccountCreations()).resolves.toBe(0);
  });
});
