import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
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
};

describe("Cybernest Manager Knowledge bridge", () => {
  it("creates one persisted Knowledge singleton and reuses it", async () => {
    const managerId = crypto.randomUUID();
    const bridge = (env as unknown as { MANAGER_KNOWLEDGE_BRIDGE: ManagerKnowledgeBridge })
      .MANAGER_KNOWLEDGE_BRIDGE;
    const userNamespace = (exports as unknown as {
      UserDurableObject: DurableObjectNamespace<ManagerKnowledgeUser>;
    }).UserDurableObject;
    const capabilityFactory = (env as unknown as {
      MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: {
        create(managerId: string): Promise<ManagerKnowledgeCapability>;
      };
    }).MANAGER_KNOWLEDGE_CAPABILITY_FACTORY;
    const capability = await capabilityFactory.create(managerId);

    await bridge.ensureManagerKnowledge(managerId, capability);
    await bridge.ensureManagerKnowledge(managerId, capability);

    const user = userNamespace.get(userNamespace.idFromName(managerId));
    const accounts = await user.listProvidedAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      vendorId: "custom",
      description: { singleton: { tsType: "KnowledgeBase" } },
    });

    await evictDurableObject(user);
    await bridge.ensureManagerKnowledge(managerId, capability);

    await expect(user.listProvidedAccounts()).resolves.toEqual(accounts);
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

    await bridge.ensureManagerKnowledge(managerId, capability);
    await expect(user.listProvidedAccounts()).resolves.toHaveLength(1);

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
    const capabilityFactory = (env as unknown as {
      MANAGER_KNOWLEDGE_CAPABILITY_FACTORY: {
        ensureDuplicate(id: string): Promise<boolean>;
      };
    }).MANAGER_KNOWLEDGE_CAPABILITY_FACTORY;

    await expect(capabilityFactory.ensureDuplicate(duplicateManagerId)).resolves.toBe(true);
  });
});
