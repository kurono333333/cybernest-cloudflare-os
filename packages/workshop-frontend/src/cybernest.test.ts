import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { DEFAULT_BANNER_COLOR } from '@gadgets/workshop-shared/api'
import { createRouter } from './router'
import {
  buildCybernestServerConfig,
  classifyCybernestPreflight,
  connectCybernest,
  isCybernestPublicRoute,
  logoutCybernest,
  retryCybernestConnection,
  workspaceShareUrl,
  type CybernestConnectionResult,
  type CybernestFetcher,
} from './cybernest'

const responseFor = (status: number) =>
  Promise.resolve(new Response(null, { status }))

describe('Cybernest frontend adapter', () => {
  it.each([
    [204, 'ready'],
    [403, 'return_to_identity'],
    [503, 'retryable'],
  ] as const)('classifies HEAD %s as %s', async (status, expected) => {
    const fetcher = vi.fn<CybernestFetcher>(() => responseFor(status))

    await expect(classifyCybernestPreflight(fetcher)).resolves.toBe(expected)
    expect(fetcher).toHaveBeenCalledWith('/manager/os', {
      method: 'HEAD',
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })

  it('classifies a preflight network failure as retryable', async () => {
    const fetcher = vi.fn<CybernestFetcher>()
      .mockRejectedValue(new TypeError('network down'))

    await expect(classifyCybernestPreflight(fetcher)).resolves.toBe('retryable')
  })

  it('does not create an OS session before HEAD readiness succeeds', async () => {
    const createSession = vi.fn<(url: string) => RpcStub<AuthenticatedApi>>()

    await expect(
      connectCybernest({
        fetcher: vi.fn<CybernestFetcher>(() => responseFor(403)),
        createSession,
        location: { protocol: 'https:', host: 'dev.dennoba.net' },
      }),
    ).resolves.toEqual({ kind: 'return_to_identity' })

    expect(createSession).not.toHaveBeenCalled()
  })

  it('creates the native AuthenticatedApi session only after HEAD 204', async () => {
    const session = {} as RpcStub<AuthenticatedApi>
    const createSession = vi.fn<(url: string) => RpcStub<AuthenticatedApi>>(
      () => session,
    )

    await expect(
      connectCybernest({
        fetcher: vi.fn<CybernestFetcher>(() => responseFor(204)),
        createSession,
        location: { protocol: 'https:', host: 'dev.dennoba.net' },
      }),
    ).resolves.toEqual({ kind: 'ready', session })

    expect(createSession).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledWith('wss://dev.dennoba.net/manager/os')
  })

  it('keeps OS outages retryable without opening a WebSocket', async () => {
    const createSession = vi.fn<(url: string) => RpcStub<AuthenticatedApi>>()

    await expect(
      connectCybernest({
        fetcher: vi.fn<CybernestFetcher>(() => responseFor(503)),
        createSession,
        location: { protocol: 'http:', host: 'localhost:3000' },
      }),
    ).resolves.toEqual({ kind: 'retryable' })

    expect(createSession).not.toHaveBeenCalled()
  })

  it('waits and retries reconnectable failures until the connection is ready', async () => {
    const session = {} as RpcStub<AuthenticatedApi>
    const connect = vi.fn<
      () => Promise<CybernestConnectionResult<RpcStub<AuthenticatedApi>>>
    >()
      .mockResolvedValueOnce({ kind: 'retryable' })
      .mockResolvedValueOnce({ kind: 'retryable' })
      .mockResolvedValueOnce({ kind: 'ready', session })
    const waitBeforeRetry = vi.fn<() => Promise<void>>()
      .mockResolvedValue(undefined)

    await expect(
      retryCybernestConnection(connect, waitBeforeRetry),
    ).resolves.toEqual({ kind: 'ready', session })

    expect(connect).toHaveBeenCalledTimes(3)
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2)
  })

  it('stops reconnecting when Core returns the user to identity', async () => {
    const connect = vi.fn<
      () => Promise<CybernestConnectionResult<RpcStub<AuthenticatedApi>>>
    >()
      .mockResolvedValueOnce({ kind: 'retryable' })
      .mockResolvedValueOnce({ kind: 'return_to_identity' })
    const waitBeforeRetry = vi.fn<() => Promise<void>>()
      .mockResolvedValue(undefined)

    await expect(
      retryCybernestConnection(connect, waitBeforeRetry),
    ).resolves.toEqual({ kind: 'return_to_identity' })

    expect(connect).toHaveBeenCalledTimes(2)
    expect(waitBeforeRetry).toHaveBeenCalledOnce()
  })

  it('selects the native workspace base path only in Cybernest mode', () => {
    expect(createRouter({ cybernestMode: true }).options.basepath).toBe('/workspace')
    expect(createRouter({ cybernestMode: false }).options.basepath).toBe('/')
  })

  it('builds one shared-origin workspace path for each frontend mode', () => {
    expect(
      workspaceShareUrl({
        origin: 'https://dev.dennoba.net',
        mode: 'cybernest',
        workspaceId: 'workspace-42',
      }),
    ).toBe('https://dev.dennoba.net/workspace/workspace/workspace-42')
    expect(
      workspaceShareUrl({
        origin: 'https://dev.dennoba.net',
        mode: 'standard',
        workspaceId: 'workspace-42',
        shareKey: 'share-key',
      }),
    ).toBe('https://dev.dennoba.net/workspace/workspace-42#share=share-key')
  })

  it('recognizes only PublicApi-only routes after Router normalization', () => {
    expect(isCybernestPublicRoute('/signup')).toBe(true)
    expect(isCybernestPublicRoute('/blueprint/blueprint-1')).toBe(true)
    expect(isCybernestPublicRoute('/')).toBe(false)
    expect(isCybernestPublicRoute('/workspaces')).toBe(false)
  })

  it('builds a local ServerConfig without invoking PublicApi', () => {
    expect(buildCybernestServerConfig('dennoba')).toEqual({
      authVendors: [],
      passwordAuthEnabled: false,
      signupsEnabled: false,
      cloudflareLimitsEnabled: false,
      siteName: 'dennoba',
      siteLogo: undefined,
      announcement: '',
      banner: '',
      bannerColor: DEFAULT_BANNER_COLOR,
      accentColor: '',
    })
  })

  it('disposes the current native stub before Core logout navigation', () => {
    const events: string[] = []
    const stub = {
      [Symbol.dispose]: vi.fn<() => void>(() => {
        events.push('dispose')
      }),
    }
    const navigate = vi.fn<(path: string) => void>((path) => {
      events.push(path)
    })

    logoutCybernest(stub, navigate)

    expect(stub[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/auth/logout')
    expect(events).toEqual(['dispose', '/auth/logout'])
  })
})
