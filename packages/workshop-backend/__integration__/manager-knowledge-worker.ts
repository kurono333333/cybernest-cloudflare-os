import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  GatekeeperUser,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ManagerKnowledgeBridge as ManagerKnowledgeBridgeImpl } from "../src/server.js";

export const GOLD_CONTROL_CONTRACT = "cybernest-knowledge-gold-job-control-v1" as const;
export const GOLD_PAGE_CONTROL_CONTRACT = "cybernest-knowledge-gold-page-control-v1" as const;

type GoldJobRoleController = Readonly<{
  assertBoundTo(
    managerId: string,
  ): typeof GOLD_CONTROL_CONTRACT | Promise<typeof GOLD_CONTROL_CONTRACT>;
}>;
type GoldPageRoleController = Readonly<{
  assertBoundTo(
    managerId: string,
  ): typeof GOLD_PAGE_CONTROL_CONTRACT | Promise<typeof GOLD_PAGE_CONTROL_CONTRACT>;
}>;

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
type ManagerKnowledgeTestGoldRoleState = {
  goldJobRole: "absent" | "installed";
  goldPageRole: "absent" | "installed";
  pageSlotEvents: string[];
  jobSlotEvents: string[];
};

const managerKnowledgeGoldRoleStates = new Map<string, ManagerKnowledgeTestGoldRoleState>();
const managerKnowledgeGoldRoleState = (managerId: string): ManagerKnowledgeTestGoldRoleState => {
  let state = managerKnowledgeGoldRoleStates.get(managerId);
  if (!state) {
    state = {
      goldJobRole: "absent",
      goldPageRole: "absent",
      pageSlotEvents: [],
      jobSlotEvents: [],
    };
    managerKnowledgeGoldRoleStates.set(managerId, state);
  }
  return state;
};

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

  async readGoldRoleStateForTest(managerId: string): Promise<ManagerKnowledgeTestGoldRoleState> {
    const state = managerKnowledgeGoldRoleState(managerId);
    return {
      ...state,
      pageSlotEvents: [...state.pageSlotEvents],
      jobSlotEvents: [...state.jobSlotEvents],
    };
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

  async inspectBronzeRoles(managerId: string): Promise<{
    writer: "absent";
    sourceReader: "absent";
  }> {
    await this.#assertManager(managerId);
    return { writer: "absent", sourceReader: "absent" };
  }

  async inspectGoldRole(managerId: string): Promise<"absent" | "installed" | "incompatible"> {
    await this.#assertManager(managerId);
    const state = managerKnowledgeGoldRoleState(managerId);
    state.jobSlotEvents.push("inspect:" + managerId);
    return state.goldJobRole;
  }

  async installGoldRole(
    managerId: string,
    controller: GoldJobRoleController,
  ): Promise<void> {
    await this.#assertManager(managerId);
    if (await controller.assertBoundTo(managerId) !== GOLD_CONTROL_CONTRACT) {
      throw new Error("Incompatible Gold job controller contract.");
    }
    const state = managerKnowledgeGoldRoleState(managerId);
    state.jobSlotEvents.push("install:" + managerId);
    state.goldJobRole = "installed";
  }

  async inspectGoldPageRole(
    managerId: string,
  ): Promise<"absent" | "installed" | "incompatible"> {
    await this.#assertManager(managerId);
    const state = managerKnowledgeGoldRoleState(managerId);
    state.pageSlotEvents.push("inspect:" + managerId);
    return state.goldPageRole;
  }

  async installGoldPageRole(
    managerId: string,
    controller: GoldPageRoleController,
  ): Promise<void> {
    await this.#assertManager(managerId);
    if (await controller.assertBoundTo(managerId) !== GOLD_PAGE_CONTROL_CONTRACT) {
      throw new Error("Incompatible Gold page controller contract.");
    }
    const state = managerKnowledgeGoldRoleState(managerId);
    state.pageSlotEvents.push("install:" + managerId);
    state.goldPageRole = "installed";
  }

  async revoke(): Promise<void> {}

  async #assertManager(managerId: string): Promise<void> {
    if (await this.ctx.props.capability.assertBoundTo(managerId) !==
        "cybernest-knowledge-read-v1") {
      throw new Error("Test Knowledge account is bound to another Manager.");
    }
  }
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
