import type { RpcStub } from 'capnweb'
import {
  DEFAULT_BANNER_COLOR,
  type AuthenticatedApi,
  type ServerConfig,
} from '@gadgets/workshop-shared/api'

export type CybernestPreflightState =
  | 'ready'
  | 'return_to_identity'
  | 'retryable'

export type CybernestFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export type CybernestLocation = Pick<Location, 'protocol' | 'host'>

export type CybernestConnectionResult<Session> =
  | { kind: 'ready'; session: Session }
  | { kind: 'return_to_identity' }
  | { kind: 'retryable' }

type ConnectOptions<Session> = {
  readonly fetcher?: CybernestFetcher
  readonly createSession: (url: string) => Session
  readonly location: CybernestLocation
}

export const CYBERNEST_WORKSPACE_BASE_PATH = '/workspace'

const defaultFetcher: CybernestFetcher = (input, init) =>
  globalThis.fetch(input, init)

export async function classifyCybernestPreflight(
  fetcher: CybernestFetcher = defaultFetcher,
): Promise<CybernestPreflightState> {
  try {
    const response = await fetcher('/manager/os', {
      method: 'HEAD',
      credentials: 'same-origin',
      cache: 'no-store',
    })

    if (response.status === 204) return 'ready'
    if (response.status === 403) return 'return_to_identity'
    return 'retryable'
  } catch {
    return 'retryable'
  }
}

export function cybernestWebSocketUrl(location: CybernestLocation): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/manager/os`
}

export async function connectCybernest<Session>({
  fetcher = defaultFetcher,
  createSession,
  location,
}: ConnectOptions<Session>): Promise<CybernestConnectionResult<Session>> {
  const preflight = await classifyCybernestPreflight(fetcher)
  if (preflight !== 'ready') return { kind: preflight }

  return {
    kind: 'ready',
    session: createSession(cybernestWebSocketUrl(location)),
  }
}

export async function retryCybernestConnection<Session>(
  connect: () => Promise<CybernestConnectionResult<Session>>,
  waitBeforeRetry: () => Promise<void>,
): Promise<Exclude<CybernestConnectionResult<Session>, { kind: 'retryable' }>> {
  while (true) {
    const result = await connect()
    if (result.kind !== 'retryable') return result
    await waitBeforeRetry()
  }
}

export function workspaceShareUrl({
  origin,
  mode,
  workspaceId,
  shareKey,
}: {
  readonly origin: string
  readonly mode: 'cybernest' | 'standard'
  readonly workspaceId: string
  readonly shareKey?: string
}): string {
  const normalizedOrigin = origin.replace(/\/+$/, '')
  const encodedWorkspaceId = encodeURIComponent(workspaceId)
  const path = mode === 'cybernest'
    ? `${CYBERNEST_WORKSPACE_BASE_PATH}/workspace/${encodedWorkspaceId}`
    : `${CYBERNEST_WORKSPACE_BASE_PATH}/${encodedWorkspaceId}`
  const fragment = shareKey === undefined ? '' : `#share=${shareKey}`
  return `${normalizedOrigin}${path}${fragment}`
}

export function isCybernestPublicRoute(pathname: string): boolean {
  return pathname === '/signup' || pathname.startsWith('/blueprint/')
}

export function buildCybernestServerConfig(siteName: string): ServerConfig {
  return {
    authVendors: [],
    passwordAuthEnabled: false,
    signupsEnabled: false,
    cloudflareLimitsEnabled: false,
    siteName,
    siteLogo: undefined,
    announcement: '',
    banner: '',
    bannerColor: DEFAULT_BANNER_COLOR,
    accentColor: '',
  }
}

type DisposableRpcStub = Pick<RpcStub<AuthenticatedApi>, typeof Symbol.dispose>

export function logoutCybernest(
  stub: DisposableRpcStub,
  navigate: (path: string) => void = (path) => globalThis.location.assign(path),
): void {
  stub[Symbol.dispose]()
  navigate('/auth/logout')
}
