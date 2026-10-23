// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const newGadget = vi.fn<() => never>();
  const defaultWorkspace = vi.fn<(action: 'observe' | 'prepare') => Promise<string | null>>(
    async () => null,
  );
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget, defaultWorkspace },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    rpcContext: null as { mode: 'cybernest' } | null,
    newGadget,
    defaultWorkspace,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    draftStorageKeys: [] as Array<string | undefined>,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./RpcContext", () => ({
  useRpcContext: () => testState.rpcContext,
}));

vi.mock("./features/chat/composer/ChatComposer", () => ({
  ChatComposer: ({ seedText, seedNonce, draftStorageKey }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.draftStorageKeys.push(draftStorageKey);
    return <textarea aria-label="Prompt" readOnly value={seedText ?? ""} />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./features/deployment-updates/UpdateAvailableNotice", () => ({ UpdateAvailableNotice: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    testState.rpcContext = null;
    testState.defaultWorkspace.mockReset().mockResolvedValue(null);
    testState.authenticatedApi = {
      listModels: testState.listModels,
      newGadget: testState.newGadget,
      defaultWorkspace: testState.defaultWorkspace,
    };
    localStorage.clear();
    testState.seeds.length = 0;
    testState.draftStorageKeys.length = 0;
    vi.clearAllMocks();
  });

  async function mountCybernestHome() {
    testState.rpcContext = { mode: 'cybernest' };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
  }

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home");
  });

  it("only observes and redirects to an existing default workspace", async () => {
    testState.defaultWorkspace.mockResolvedValue('workspace-existing');
    await mountCybernestHome();

    expect(testState.defaultWorkspace).toHaveBeenCalledExactlyOnceWith('observe');
    expect(testState.defaultWorkspace).not.toHaveBeenCalledWith('prepare');
    expect(testState.navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/workspace/$id',
      params: { id: 'workspace-existing' },
      search: {},
    });
  });

  it("prepares only after an explicit action and dispatches prepare once", async () => {
    testState.defaultWorkspace
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('workspace-prepared');
    await mountCybernestHome();

    const prepareButton = container!.querySelector<HTMLButtonElement>('button');
    expect(prepareButton?.textContent).toBe('Prepare workspace');
    await act(async () => {
      prepareButton!.click();
      prepareButton!.click();
    });

    expect(testState.defaultWorkspace.mock.calls.map(([action]) => action)).toEqual([
      'observe',
      'prepare',
    ]);
    expect(testState.navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/workspace/$id',
      params: { id: 'workspace-prepared' },
      search: {},
    });
  });

  it("observes after an uncertain prepare and never prepares again", async () => {
    testState.defaultWorkspace
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('prepare response lost'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    await mountCybernestHome();

    await act(async () => container!.querySelector<HTMLButtonElement>('button')!.click());
    expect(container!.querySelector('[role="alert"]')?.textContent).toMatch(/Check again/);
    expect(testState.defaultWorkspace.mock.calls.map(([action]) => action)).toEqual([
      'observe',
      'prepare',
      'observe',
    ]);

    await act(async () => container!.querySelector<HTMLButtonElement>('button')!.click());
    expect(testState.defaultWorkspace.mock.calls.map(([action]) => action)).toEqual([
      'observe',
      'prepare',
      'observe',
      'observe',
    ]);
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("ignores an older root's delayed observe after a newer root takes over", async () => {
    let resolveOld!: (id: string | null) => void;
    const oldObserve = vi.fn(() => new Promise<string | null>((resolve) => { resolveOld = resolve; }));
    testState.authenticatedApi = { ...testState.authenticatedApi, defaultWorkspace: oldObserve };
    await mountCybernestHome();

    const newObserve = vi.fn(async () => null);
    testState.authenticatedApi = { ...testState.authenticatedApi, defaultWorkspace: newObserve };
    await act(async () => root!.render(<HomePageContent />));
    expect(newObserve).toHaveBeenCalledExactlyOnceWith('observe');

    await act(async () => { resolveOld('workspace-from-old-root'); });

    expect(testState.navigate).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('No workspace is ready yet.');
  });

  it("lets only the newest overlapping observe navigate", async () => {
    let resolveFirst!: (id: string | null) => void;
    let resolveSecond!: (id: string | null) => void;
    testState.defaultWorkspace
      .mockRejectedValueOnce(new Error('initial observation unavailable'))
      .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<string | null>((resolve) => { resolveSecond = resolve; }));
    await mountCybernestHome();

    const checkButton = container!.querySelector<HTMLButtonElement>('button');
    expect(checkButton?.textContent).toBe('Check workspace');
    await act(async () => {
      checkButton!.click();
      checkButton!.click();
    });

    await act(async () => { resolveSecond('workspace-from-newest-observe'); });
    await act(async () => { resolveFirst('workspace-from-stale-observe'); });

    expect(testState.navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/workspace/$id',
      params: { id: 'workspace-from-newest-observe' },
      search: {},
    });
  });

  it("ignores a prepared workspace returned late by a replaced root", async () => {
    let resolvePrepare!: (id: string | null) => void;
    const oldRootDefaultWorkspace = vi.fn((action: 'observe' | 'prepare') => {
      if (action === 'prepare') return new Promise<string | null>((resolve) => { resolvePrepare = resolve; });
      return Promise.resolve(null);
    });
    testState.authenticatedApi = {
      ...testState.authenticatedApi,
      defaultWorkspace: oldRootDefaultWorkspace,
    };
    await mountCybernestHome();
    await act(async () => container!.querySelector<HTMLButtonElement>('button')!.click());

    const newRootDefaultWorkspace = vi.fn(async () => null);
    testState.authenticatedApi = {
      ...testState.authenticatedApi,
      defaultWorkspace: newRootDefaultWorkspace,
    };
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => { resolvePrepare('workspace-from-old-prepare'); });

    expect(oldRootDefaultWorkspace).toHaveBeenCalledWith('prepare');
    expect(newRootDefaultWorkspace).toHaveBeenCalledExactlyOnceWith('observe');
    expect(testState.navigate).not.toHaveBeenCalled();
  });
});
