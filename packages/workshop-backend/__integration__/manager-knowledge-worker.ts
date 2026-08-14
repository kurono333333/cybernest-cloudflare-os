import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  GatekeeperUser,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/server.js";
export * from "../src/server.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export for entrypoints.
export {
  GatekeeperConnectCallbackImpl,
  ExternalMessageGateway,
  ManagerKnowledgeBridge,
  UserDurableObject,
} from "../src/server.js";

type ManagerKnowledgeCapability = {
  assertBoundTo(managerId: string): Promise<void>;
};

type TestAccountProps = {
  capability: ManagerKnowledgeCapability;
};

export let managerKnowledgeAccountCreations = 0;

export class ManagerKnowledgeTestCapability
  extends WorkerEntrypoint<Cloudflare.Env, { managerId: string }> {
  async assertBoundTo(managerId: string): Promise<void> {
    if (this.ctx.props.managerId !== managerId) {
      throw new Error("Test capability is bound to a different Manager.");
    }
  }
}

export class ManagerKnowledgeTestCapabilityFactory extends WorkerEntrypoint {
  async create(managerId: string): Promise<ManagerKnowledgeCapability> {
    let workerExports = this.ctx.exports as unknown as {
      ManagerKnowledgeTestCapability(input: { props: { managerId: string } }): ManagerKnowledgeCapability;
    };
    return workerExports.ManagerKnowledgeTestCapability({ props: { managerId } });
  }

  async ensureDuplicate(managerId: string): Promise<boolean> {
    let capability = await this.create(managerId);
    let bridge = (this.env as unknown as {
      MANAGER_KNOWLEDGE_BRIDGE: {
        ensureManagerKnowledge(
          id: string,
          access: ManagerKnowledgeCapability,
        ): Promise<void>;
      };
    }).MANAGER_KNOWLEDGE_BRIDGE;
    try {
      await bridge.ensureManagerKnowledge(managerId, capability);
      return false;
    } catch (error) {
      return error instanceof Error && error.message.includes("duplicate connected account");
    }
  }
}

export class ManagerKnowledgeTestVendor extends WorkerEntrypoint {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Test Knowledge Vendor", url: "knowledge://test" };
  }

  async createManagerAccount(
    managerId: string,
    capability: ManagerKnowledgeCapability,
  ): Promise<Fetcher<GatekeeperUser>> {
    await capability.assertBoundTo(managerId);
    managerKnowledgeAccountCreations++;
    let workerExports = this.ctx.exports as unknown as {
      ManagerKnowledgeTestAccount(input: { props: TestAccountProps }): Fetcher<GatekeeperUser>;
    };
    return workerExports.ManagerKnowledgeTestAccount({ props: { capability } });
  }

  async createLegacyAccount(): Promise<Fetcher<GatekeeperUser>> {
    let workerExports = this.ctx.exports as unknown as {
      ManagerKnowledgeTestLegacyAccount(input: {}): Fetcher<GatekeeperUser>;
    };
    return workerExports.ManagerKnowledgeTestLegacyAccount({});
  }

  async connectAccount(): Promise<{ url: string }> {
    return { url: "knowledge://test/connect" };
  }

  async getSupportedResources(): Promise<[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return "";
  }
}

export class ManagerKnowledgeTestAccount
  extends WorkerEntrypoint<Cloudflare.Env, TestAccountProps> {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Knowledge Base",
      url: "knowledge://current",
      singleton: { tsType: "KnowledgeBase" },
    };
  }

  async inspectManagerBinding(managerId: string): Promise<"legacy" | "bound"> {
    await this.ctx.props.capability.assertBoundTo(managerId);
    return "bound";
  }

  async revoke(): Promise<void> {}
}

export class ManagerKnowledgeTestLegacyAccount extends WorkerEntrypoint {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Custom Gatekeeper",
      url: "custom://deployment-info",
      singleton: { tsType: "CustomSession" },
    };
  }

  async inspectManagerBinding(): Promise<"legacy"> {
    return "legacy";
  }

  async revoke(): Promise<void> {}
}
