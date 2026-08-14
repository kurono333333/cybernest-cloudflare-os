import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";

type ManagerKnowledgeBridge = {
  ensureManagerKnowledge(
    managerId: string,
    capability: ManagerKnowledgeCapability,
  ): Promise<void>;
};

type ManagerKnowledgeCapability = {
  assertBoundTo(managerId: string): Promise<void>;
};

type ManagerKnowledgeUser = {
  ensureCybernestManager(managerId: string): Promise<void>;
  ensureKnowledgeAccount(capability: ManagerKnowledgeCapability): Promise<void>;
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
  listProvidedAccounts(): Promise<Array<{
    accountId: number;
    vendorId: string;
    description: { singleton?: { tsType?: string } };
  }>>;
  disconnectAccount(accountId: number): Promise<void>;
  subscribeConnectedAccounts(subscriber: RpcStub<ConnectedAccountsSubscriber>): Promise<
    RpcStub<Record<string, never>>
  >;
};

type ConnectedAccountsSubscriber = {
  add(id: number): void;
  remove(id: number): void;
  ready(): void;
};

type CapabilityFactory = {
  create(managerId: string): Promise<ManagerKnowledgeCapability>;
  ensureDuplicate(managerId: string): Promise<boolean>;
  resetAccountCreations(): Promise<void>;
  readAccountCreations(): Promise<number>;
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

describe("Cybernest Manager Knowledge bridge", () => {
  it("creates one persisted Knowledge singleton and reuses it", async () => {
    const managerId = crypto.randomUUID();
    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const userNamespace = (exports as unknown as {
      UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
    }).UserDurableObject;
    const factory = capabilityFactory();
    await factory.resetAccountCreations();
    const capability = await factory.create(managerId);

    const user = userNamespace.get(userNamespace.idFromName(managerId));
    await user.ensureCybernestManager(managerId);
    await expect(user.listProvidedAccounts()).resolves.toEqual([]);
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
        await (instance as unknown as ManagerKnowledgeUser)
          .disconnectAccount(accounts[0]!.accountId);
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

  it("fails closed before Account creation for missing, invalid, or unreadable User state", async () => {
    const userNamespace = (exports as unknown as {
      UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
    }).UserDurableObject;
    const factory = capabilityFactory();
    await factory.resetAccountCreations();

    const missingManagerId = crypto.randomUUID();
    const missingUser = userNamespace.get(userNamespace.idFromName(missingManagerId));
    const missingCapability = await factory.create(missingManagerId);
    const missingError = await runInDurableObject(missingUser, async (instance) => {
      try {
        await (instance as unknown as ManagerKnowledgeUser)
          .ensureKnowledgeAccount(missingCapability);
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
        await (instance as unknown as ManagerKnowledgeUser)
          .ensureKnowledgeAccount(invalidCapability);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(invalidError).toContain("User profile is not a Manager");

    const unreadableManagerId = crypto.randomUUID();
    const unreadableUser = userNamespace.get(userNamespace.idFromName(unreadableManagerId));
    await unreadableUser.ensureCybernestManager(unreadableManagerId);
    const unreadableError = await runInDurableObject(unreadableUser, async (instance) => {
      const target = instance as unknown as ManagerKnowledgeUser & {
        ctx: {
          exports: {
            ManagerKnowledgeTestCapability(input: {
              props: {managerId: string};
            }): ManagerKnowledgeCapability;
          };
          storage: {
            kv: {
              get(key: string): unknown;
              put(key: string, value: unknown): void;
            };
          };
        };
      };
      const kv = target.ctx.storage.kv;
      const unreadableCapability = target.ctx.exports.ManagerKnowledgeTestCapability({
        props: {managerId: unreadableManagerId},
      });
      kv.put("nextAccountId", 1);
      const originalGet = kv.get;
      kv.get = (key) => {
        if (key === "connectedAccounts:a0") throw new Error("unreadable test slot");
        return originalGet.call(kv, key);
      };
      try {
        await target.ensureKnowledgeAccount(unreadableCapability);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        kv.get = originalGet;
        (unreadableCapability as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
      }
    });
    expect(unreadableError).toContain("unreadable connected account");
    await expect(factory.readAccountCreations()).resolves.toBe(0);
  });

  it("replaces one legacy Custom account but refuses duplicate legacy slots", async () => {
    const managerId = crypto.randomUUID();
    const userNamespace = (exports as unknown as {
      UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
    }).UserDurableObject;
    const user = userNamespace.get(userNamespace.idFromName(managerId));
    const vendor = (env as unknown as {
      GATEKEEPER_CUSTOM: {
        createLegacyAccount(): Promise<object>;
      };
    }).GATEKEEPER_CUSTOM;
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
    const capability = await (env as unknown as {
      MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: {
        create(id: string): Promise<ManagerKnowledgeCapability>;
      };
    }).MANAGER_KNOWLEDGE_CAPABILITY_FACTORY.create(managerId);

    const factory = capabilityFactory();
    await factory.resetAccountCreations();
    const legacyAccounts = await user.listProvidedAccounts();
    expect(legacyAccounts).toHaveLength(1);

    await bridge.ensureManagerKnowledge(managerId, capability);
    const boundAccounts = await user.listProvidedAccounts();
    expect(boundAccounts).toHaveLength(1);
    expect(boundAccounts[0]!.accountId).not.toBe(legacyAccounts[0]!.accountId);
    expect(boundAccounts[0]!.description.singleton?.tsType).toBe("KnowledgeBase");
    await bridge.ensureManagerKnowledge(managerId, capability);
    await expect(user.listProvidedAccounts()).resolves.toEqual(boundAccounts);
    await expect(factory.readAccountCreations()).resolves.toBe(1);

    const duplicateManagerId = crypto.randomUUID();
    const duplicateUser = userNamespace.get(userNamespace.idFromName(duplicateManagerId));
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
    await expect(factory.ensureDuplicate(duplicateManagerId)).resolves.toBe(true);
  });
});
