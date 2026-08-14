import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { newWebSocketRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext, type RpcContextValue } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { ThemeProvider } from './ThemeContext'
import { createRouter } from './router'
import AnnouncementBanner from './components/AnnouncementBanner'
import { applyAccentColor, applyStoredThemeMode } from './theme'
import './styles.css'
import FrontendErrorBoundary from './FrontendErrorBoundary'
import { installWorkshopErrorReporting, reportIssue } from './errorReporting'
import { applySiteFavicon, cacheBustSiteLogoUrl } from './siteLogoUtils'
import {
  buildCybernestServerConfig,
  connectCybernest,
  retryCybernestConnection,
} from './cybernest'

const CYBERNEST_MODE = import.meta.env.VITE_CYBERNEST_MODE === 'true'
const CYBERNEST_SITE_NAME = import.meta.env.VITE_SITE_NAME?.trim() || 'dennoba'

// ---------------------------------------------------------------------------
// Dev auto-login: standard OS mode only. Cybernest mode receives an already
// authenticated native AuthenticatedApi from Core and never reads OS tokens.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'
  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  let token = await stub.createAccount(username, username, passwordHash)
  if (!token) token = await stub.login(username, passwordHash)

  if (token) localStorage.setItem('authToken', token)
}

type RpcConnection =
  | { readonly kind: 'public'; readonly stub: RpcStub<PublicApi> }
  | { readonly kind: 'authenticated'; readonly stub: RpcStub<AuthenticatedApi> }

type ReadyRuntime = {
  readonly rpc: RpcContextValue
  readonly router: ReturnType<typeof createRouter>
}

// WebSocket connection management stays outside React so StrictMode does not
// create competing sessions during its development-only effect replay.
let lastConnectTime = 0
let backoff = 1000
let currentConnection: RpcConnection | null = null
let isConnectionLost = false
const notifyCurrentConnectionUpdated: Set<() => void> = new Set()

function getBackendHost(): string {
  const backendHost = import.meta.env.VITE_BACKEND_HOST?.trim()
  if (backendHost) return backendHost
  return window.location.hostname === 'localhost' ? 'localhost:8787' : window.location.host
}

function startPublicConnection(): RpcStub<PublicApi> {
  lastConnectTime = Date.now()
  const apiHost = getBackendHost()
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api'
  return newWebSocketRpcSession<PublicApi>(wsUrl)
}

async function startCybernestConnection() {
  return connectCybernest({
    location: window.location,
    createSession: (url) => newWebSocketRpcSession<AuthenticatedApi>(url),
  })
}

function contextValue(connection: RpcConnection): RpcContextValue {
  return {
    ...connection,
    connectionLost: isConnectionLost,
    markConnectionRestored,
  }
}

async function handleBroken(error: unknown): Promise<void> {
  console.warn('RPC connection lost:', error)

  isConnectionLost = true
  for (const callback of notifyCurrentConnectionUpdated) callback()

  const timeSinceConnect = Date.now() - lastConnectTime
  if (timeSinceConnect < backoff) {
    const waitTime = backoff - timeSinceConnect
    console.warn(`Will try again in ${Math.round(waitTime / 1000)} seconds...`)
    await new Promise((resolve) => setTimeout(resolve, waitTime))
    console.warn('Retrying connection...')
    backoff = Math.min(backoff * 2, 10000)
  } else {
    backoff = 1000
  }

  if (CYBERNEST_MODE) {
    const result = await retryCybernestConnection(
      startCybernestConnection,
      async () => {
        const waitTime = backoff
        console.warn(`Will try again in ${Math.round(waitTime / 1000)} seconds...`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        console.warn('Retrying connection...')
        backoff = Math.min(waitTime * 2, 10000)
      },
    )
    if (result.kind === 'return_to_identity') {
      window.location.assign('/')
      return
    }

    lastConnectTime = Date.now()
    currentConnection = { kind: 'authenticated', stub: result.session }
    currentConnection.stub.onRpcBroken(handleBroken)
  } else {
    currentConnection = { kind: 'public', stub: startPublicConnection() }
    currentConnection.stub.onRpcBroken(handleBroken)
  }

  for (const callback of notifyCurrentConnectionUpdated) callback()
}

function markConnectionRestored(): void {
  if (!isConnectionLost) return
  isConnectionLost = false
  for (const callback of notifyCurrentConnectionUpdated) callback()
}

if (!CYBERNEST_MODE) {
  installWorkshopErrorReporting()
  currentConnection = { kind: 'public', stub: startPublicConnection() }
  currentConnection.stub.onRpcBroken(handleBroken)
}

function CybernestBootScreen({
  retryable,
  onRetry,
}: {
  readonly retryable: boolean
  readonly onRetry: () => void
}) {
  return (
    <main className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base p-6">
      {retryable ? (
        <>
          <p className="text-sm text-kumo-danger">Workspaceを準備できませんでした。</p>
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
          >
            再試行
          </button>
        </>
      ) : (
        <>
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">Workspaceを準備しています。</p>
        </>
      )}
    </main>
  )
}

function AppWithConnection() {
  const [runtime, setRuntime] = useState<ReadyRuntime | null>(() => {
    if (CYBERNEST_MODE || !currentConnection) return null
    return {
      rpc: contextValue(currentConnection),
      router: createRouter({ cybernestMode: false }),
    }
  })
  const [bootRetryable, setBootRetryable] = useState(false)
  const bootStarted = useRef(false)
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null)
  const [serverConfigError, setServerConfigError] = useState(false)

  const publishCurrentConnection = () => {
    if (!currentConnection) return
    setRuntime((previous) => ({
      rpc: contextValue(currentConnection!),
      router: previous?.router ?? createRouter({ cybernestMode: CYBERNEST_MODE }),
    }))
  }

  const bootCybernest = async () => {
    setBootRetryable(false)
    const result = await startCybernestConnection()
    if (result.kind === 'return_to_identity') {
      window.location.assign('/')
      return
    }
    if (result.kind === 'retryable') {
      setBootRetryable(true)
      return
    }

    lastConnectTime = Date.now()
    currentConnection = { kind: 'authenticated', stub: result.session }
    currentConnection.stub.onRpcBroken(handleBroken)
    setServerConfig(buildCybernestServerConfig(CYBERNEST_SITE_NAME))
    setRuntime({
      rpc: contextValue(currentConnection),
      router: createRouter({ cybernestMode: true }),
    })
  }

  useEffect(() => {
    const callback = () => publishCurrentConnection()
    notifyCurrentConnectionUpdated.add(callback)

    if (CYBERNEST_MODE && !bootStarted.current) {
      bootStarted.current = true
      void bootCybernest()
    }

    return () => {
      notifyCurrentConnectionUpdated.delete(callback)
    }
  }, [])

  useEffect(() => {
    if (!runtime || runtime.rpc.kind !== 'public') return
    let cancelled = false
    setServerConfigError(false)
    runtime.rpc.stub.getServerConfig()
      .then((config) => {
        if (!cancelled) {
          setServerConfig(config.siteLogo ? {
            ...config,
            siteLogo: { url: cacheBustSiteLogoUrl(config.siteLogo.url) },
          } : config)
        }
      })
      .catch(() => {
        if (!cancelled) setServerConfigError(true)
      })
    return () => {
      cancelled = true
    }
  }, [runtime?.rpc.stub])

  useEffect(() => {
    applyAccentColor(serverConfig?.accentColor ?? '')
  }, [serverConfig?.accentColor])

  useEffect(() => {
    if (CYBERNEST_MODE) return
    return applySiteFavicon(serverConfig?.siteLogo?.url)
  }, [serverConfig])

  if (!runtime) {
    return (
      <CybernestBootScreen
        retryable={bootRetryable}
        onRetry={() => void bootCybernest()}
      />
    )
  }

  return (
    <ThemeProvider>
      <RpcContext.Provider value={runtime.rpc}>
        <ServerConfigErrorContext.Provider value={serverConfigError}>
          <ServerConfigContext.Provider value={serverConfig}>
            <AnnouncementBanner />
            <RouterProvider router={runtime.router} />
          </ServerConfigContext.Provider>
        </ServerConfigErrorContext.Provider>
      </RpcContext.Provider>
    </ThemeProvider>
  )
}

applyStoredThemeMode()

const root = createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop.react-root', error, {
    handled: false, severity: 'fatal', captureMechanism: 'react',
  }),
})

const initialPublicConnection = currentConnection
if (initialPublicConnection?.kind === 'public') {
  void devAutoLogin(initialPublicConnection.stub).catch(() => {})
}

root.render(
  <StrictMode>
    <FrontendErrorBoundary>
      <AppWithConnection />
    </FrontendErrorBoundary>
  </StrictMode>,
)
