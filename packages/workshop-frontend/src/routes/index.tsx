import { classifyRpcError, logRpcFailure, rpcFailureDescription } from "../rpcErrors";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ChatComposer } from "../features/chat/composer/ChatComposer";
import MeshBackground from "../components/MeshBackground";
import HomeTaskSuggestions from "../components/AppShell/HomeTaskSuggestions";
import { UpdateAvailableNotice } from "../features/deployment-updates/UpdateAvailableNotice";
import { useAuthenticatedApi } from "../AuthContext";
import { useRpcContext } from "../RpcContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../modelSelection";
import { useDocumentTitle } from "../useDocumentTitle";
import { homePromptFromSearch } from "../homePrompt";
import { composerDraftStorageKey } from "../features/chat/composer/draft/composerDraft";

type HomeSearch = {
  prompt?: string;
  cfos_native_state?: string;
  cfos_native_key?: string;
};

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
    cfos_native_state: typeof search.cfos_native_state === "string"
      ? search.cfos_native_state : undefined,
    cfos_native_key: typeof search.cfos_native_key === "string"
      ? search.cfos_native_key : undefined,
  }),
});

// The Home page is the "new workspace" launcher. Persistent navigation (recents, favorites) lives
// in the AppShell rail, so this page focuses on a single thing: composing the first message of a
// new gadget — a centered column with a hero, the prompt composer, and a few task suggestions.
function HomePage() {
  return <HomePageContent prompt={Route.useSearch().prompt} />;
}

export function HomePageContent({ prompt }: HomeSearch) {
  useDocumentTitle("Home");
  const rpcContext = useRpcContext()
  return rpcContext?.mode === 'cybernest'
    ? <CybernestHomePage />
    : <NativeHomePageContent prompt={prompt} />
}

function NativeHomePageContent({ prompt }: HomeSearch) {

  const { authenticatedApi, currentUser } = useAuthenticatedApi();
  const navigate = useNavigate();
  const toasts = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: (previous?.nonce ?? 0) + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        logRpcFailure("Failed to fetch models:", err);
        // Toast unless it's a connection error (reconnect refetches); a do-reset here already
        // survived the Worker's same-colo retry, so the user should hear about it.
        if (classifyRpcError(err) !== "connection") {
          toasts.add({ title: "Couldn't load AI models", variant: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newGadget();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, {id}] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        // Open the conversation we just started.
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        const transient = logRpcFailure("Failed to create gadget:", err,
            { reportSite: "workspace.create" });
        // A retry reuses the provisional gadget while the draft contains gadget-scoped references.
        if (!attachments?.length && !capsules?.length) {
          provisionalOverseerRef.current?.stub[Symbol.dispose]();
          provisionalOverseerRef.current = null;
        }
        if (!transient) {
          toasts.add({
            title: "Failed to create workspace",
            description: rpcFailureDescription(err),
            variant: "error",
          });
        }
        throw err;
      }
    },
    [ensureProvisionalGadget, navigate, toasts],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url);
    },
    [ensureProvisionalGadget],
  );

  return (
    // Flat enterprise treatment: no mesh, no watermark hexagon, no prompt-glow. The AppShell's
    // <main> already supplies a faint dotted grid as the page background.
    <div className="relative isolate flex min-h-full w-full flex-col items-center justify-start px-4 pb-16 pt-10 sm:px-8 sm:pt-16 lg:pt-24">
      <UpdateAvailableNotice />
      {/* The brand hex mesh, restored and de-warmed for the new system: a gentle perspective hex
          grid receding upward. Masked to fade out before the composer so it stays a quiet backdrop. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-8">
        {/* Hero */}
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            What are we working on?
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            Ask a question, create an output, or create an app that works with your tools and data.
          </p>
        </header>

        {/* Composer */}
        <ChatComposer
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel === null ? null : { id: selectedModel }}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          minRows={3}
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          draftStorageKey={currentUser
            ? composerDraftStorageKey(currentUser.id, "home")
            : undefined}
        />

        {/* A few example work tasks to spark ideas. Picking one seeds the composer above. */}
        <HomeTaskSuggestions
          onPick={(suggestion) =>
            setSeed((prev) => ({ text: suggestion, nonce: (prev?.nonce ?? 0) + 1 }))
          }
        />
      </div>
    </div>
  );
}

function CybernestHomePage() {
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const [state, setState] = useState<'loading' | 'empty' | 'preparing' | 'unknown'>('loading')
  const prepareAttemptedRef = useRef(false)
  const operationGenerationRef = useRef(0)

  const observeDefaultWorkspace = useCallback(async (afterPrepare = false) => {
    const api = authenticatedApi
    const generation = ++operationGenerationRef.current
    setState('loading')
    try {
      const id = await api.defaultWorkspace('observe')
      if (generation !== operationGenerationRef.current) return
      if (id) {
        await navigate({ to: '/workspace/$id', params: { id }, search: {} })
      } else {
        setState(afterPrepare ? 'unknown' : 'empty')
      }
    } catch {
      if (generation !== operationGenerationRef.current) return
      setState('unknown')
    }
  }, [authenticatedApi, navigate])

  useLayoutEffect(() => {
    prepareAttemptedRef.current = false
    operationGenerationRef.current++
    return () => {
      operationGenerationRef.current++
    }
  }, [authenticatedApi])

  useEffect(() => {
    void observeDefaultWorkspace()
  }, [observeDefaultWorkspace])

  const prepareDefaultWorkspace = async () => {
    if (prepareAttemptedRef.current) return
    prepareAttemptedRef.current = true
    const api = authenticatedApi
    const generation = ++operationGenerationRef.current
    setState('preparing')
    try {
      const id = await api.defaultWorkspace('prepare')
      if (generation !== operationGenerationRef.current) return
      if (id) {
        await navigate({ to: '/workspace/$id', params: { id }, search: {} })
        return
      }
    } catch {
      if (generation !== operationGenerationRef.current) return
      // An uncertain prepare is followed only by a read-only observation.
    }
    await observeDefaultWorkspace(true)
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base p-6 text-center">
      {state === 'loading' || state === 'preparing' ? (
        <>
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">
            {state === 'preparing' ? 'Preparing your workspace…' : 'Opening your workspace…'}
          </p>
        </>
      ) : state === 'empty' ? (
        <>
          <p className="text-sm text-kumo-subtle">No workspace is ready yet.</p>
          <button
            type="button"
            onClick={() => void prepareDefaultWorkspace()}
            className="rounded-lg bg-kumo-brand px-4 py-2 text-sm font-medium text-kumo-inverse hover:bg-kumo-brand-hover"
          >
            Prepare workspace
          </button>
        </>
      ) : (
        <>
          <p role="alert" className="text-sm text-kumo-danger">
            Workspace status is uncertain. Check again before preparing another workspace.
          </p>
          <button
            type="button"
            onClick={() => void observeDefaultWorkspace(prepareAttemptedRef.current)}
            className="rounded-lg border border-kumo-line px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
          >
            Check workspace
          </button>
        </>
      )}
    </div>
  )
}
