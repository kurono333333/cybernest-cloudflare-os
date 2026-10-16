import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  GatekeeperUser,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ManagerKnowledgeBridge as ManagerKnowledgeBridgeImpl } from "../src/server.js";

export { default } from "../src/server.js";
export * from "../src/server.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export for entrypoints.
export {
  GatekeeperConnectCallbackImpl,
  ExternalMessageGateway,
  ManagerKnowledgeBridge,
  UserDurableObject,
} from "../src/server.js";

export type ManagerKnowledgeCapability = Fetcher<ManagerKnowledgeTestCapability>;

type TestAccountProps = {
  capability: ManagerKnowledgeCapability;
};

export let managerKnowledgeAccountCreations = 0;

export class ManagerKnowledgeTestCapability
  extends WorkerEntrypoint<Cloudflare.Env, { managerId: string }> {
  async assertBoundTo(managerId: string): Promise<"cybernest-knowledge-read-v1"> {
    if (this.ctx.props.managerId !== managerId) {
      throw new Error("Test capability is bound to a different Manager.");
    }
    return "cybernest-knowledge-read-v1";
  }
}

export class ManagerKnowledgeTestCapabilityFactory extends WorkerEntrypoint<Cloudflare.Env> {
  async resetAccountCreations(): Promise<void> {
    managerKnowledgeAccountCreations = 0;
  }

  async readAccountCreations(): Promise<number> {
    return managerKnowledgeAccountCreations;
  }

  async captureBridgeEnsure(
    managerId: string,
  ): Promise<string | null> {
    const capability = await this.create(managerId);
    try {
      const bridge = new ManagerKnowledgeBridgeImpl(this.ctx, this.env);
      await bridge.ensureManagerKnowledge(managerId, capability);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async create(managerId: string): Promise<ManagerKnowledgeCapability> {
    let workerExports = this.ctx.exports as Cloudflare.Exports & {
      ManagerKnowledgeTestCapability(input: { props: { managerId: string } }): ManagerKnowledgeCapability;
    };
    return workerExports.ManagerKnowledgeTestCapability({ props: { managerId } });
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
      avatar: { url: "" },
      singleton: { tsType: "KnowledgeBase" },
    };
  }

  async inspectManagerBinding(
    managerId: string,
  ): Promise<"legacy" | "bound" | "incompatible"> {
    const contract = await this.ctx.props.capability.assertBoundTo(managerId);
    return contract === "cybernest-knowledge-read-v1" ? "bound" : "incompatible";
  }

  async revoke(): Promise<void> {}
}

export class ManagerKnowledgeTestLegacyAccount extends WorkerEntrypoint {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Custom Gatekeeper",
      avatar: { url: "" },
      singleton: { tsType: "CustomSession" },
    };
  }

  async inspectManagerBinding(): Promise<"legacy"> {
    return "legacy";
  }

  async revoke(): Promise<void> {}
}
