import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  CybernestConnectionBootstrapApi,
  ServerConfig,
} from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCybernestConnectionOwner } from './connectionOwner'

type NativeProofResult = Awaited<
  ReturnType<RpcStub<CybernestConnectionBootstrapApi>['presentProof']>
>
type ConnectionOwner = ReturnType<typeof createCybernestConnectionOwner>

const owners: ConnectionOwner[] = []
const PROOF_ATTEMPT_TIMEOUT_MS = 20_000
const WAKE_PROBE_TIMEOUT_MS = 10_000
const WAKE_PROBE_MIN_IDLE_MS = 15_000
const serverConfig = {
  authVendors: [],
  passwordAuthEnabled: true,
  cloudflareLimitsEnabled: false,
  signupsEnabled: true,
  userSearchEnabled: true,
  siteName: 'Cybernest test',
  announcement: '',
  banner: '',
  bannerColor: 'neutral',
  accentColor: '',
} satisfies ServerConfig

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function authenticatedRoot() {
  const dispose = vi.fn()
  const whoami = vi.fn<() => Promise<unknown>>()
  let root: RpcStub<AuthenticatedApi>
  root = {
    whoami,
    onRpcBroken: vi.fn(),
    dup: vi.fn(() => root),
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<AuthenticatedApi>
  return { root, dispose, whoami }
}

function bootstrapSession(
  presentProof: (proof: string) => Promise<NativeProofResult>,
  disposeBreaks = false,
) {
  let onBroken: ((error: unknown) => void) | undefined
  const dispose = vi.fn(() => {
    if (disposeBreaks) onBroken?.(new Error('socket closed during dispose'))
  })
  const rpc = {
    presentProof: vi.fn(presentProof),
    getBlueprint: vi.fn(),
    downloadBlueprint: vi.fn(),
    onRpcBroken: (callback: (error: unknown) => void) => { onBroken = callback },
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<CybernestConnectionBootstrapApi>

  return {
    rpc,
    dispose,
    presentProof: rpc.presentProof,
    break: () => onBroken?.(new Error('socket closed')),
  }
}

function proofResult(authenticatedApi: RpcStub<AuthenticatedApi>) {
  const dispose = vi.fn(() => authenticatedApi[Symbol.dispose]())
  const result = {
    authenticatedApi,
    serverConfig,
    [Symbol.dispose]: dispose,
  } satisfies NativeProofResult
  return { result, dispose }
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function makeOwner(
  fetch: typeof globalThis.fetch,
  createSession: () => RpcStub<CybernestConnectionBootstrapApi>,
) {
  const owner = createCybernestConnectionOwner({ fetch, createSession })
  owners.push(owner)
  return owner
}

afterEach(() => {
  for (const owner of owners) owner.stop()
  owners.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Cybernest connection owner', () => {
  it('keeps root and config private until Core proof and native presentProof both succeed', async () => {
    const coreResponse = deferred<Response>()
    const nativeResult = deferred<NativeProofResult>()
    const session = bootstrapSession(() => nativeResult.promise)
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(coreResponse.promise)
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)

    const connecting = owner.start()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'connecting',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(createSession).not.toHaveBeenCalled()

    coreResponse.resolve(jsonResponse(200, { proof: 'fixture-proof' }))
    await flushMicrotasks()

    expect(fetch).toHaveBeenCalledExactlyOnceWith('/os/connection-proof', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: '{}',
    }))
    expect(session.presentProof).toHaveBeenCalledExactlyOnceWith('fixture-proof')
    expect(owner.getSnapshot()).toMatchObject({
      status: 'connecting',
      authenticatedApi: null,
      serverConfig: null,
    })

    const root = authenticatedRoot()
    const result = proofResult(root.root)
    nativeResult.resolve(result.result)
    await connecting

    expect(owner.getSnapshot()).toMatchObject({
      status: 'authenticated',
      authenticatedApi: root.root,
      serverConfig: result.result.serverConfig,
    })
  })

  it.each([
    [401, 'unauthenticated'],
    [403, 'denied'],
    [503, 'unavailable'],
  ] as const)(
    'stops safely on Core status %i without opening a socket or retrying later',
    async (status, reason) => {
      vi.useFakeTimers()
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(status, {}))
      const createSession = vi.fn<() => RpcStub<CybernestConnectionBootstrapApi>>()
      const owner = makeOwner(fetch, createSession)

      await owner.start()

      expect(owner.getSnapshot()).toMatchObject({
        status: 'stopped',
        reason,
        authenticatedApi: null,
        serverConfig: null,
      })
      expect(createSession).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(createSession).not.toHaveBeenCalled()
    },
  )

  const requestFailures: [string, () => Promise<Response>][] = [
    ['Core request failure', async () => { throw new Error('network failure') }],
    ['malformed Core response', async () => new Response('{', { status: 200 })],
    ['missing proof in Core response', async () => jsonResponse(200, {})],
  ]

  it.each(requestFailures)('%s stops before opening an OS socket', async (_label, respond) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(respond)
    const createSession = vi.fn<() => RpcStub<CybernestConnectionBootstrapApi>>()
    const owner = makeOwner(fetch, createSession)

    await owner.start()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('stops and releases the bootstrap socket when native proof is rejected', async () => {
    const session = bootstrapSession(async () => { throw new Error('proof rejected') })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(200, { proof: 'fixture-proof' }),
    )
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(session.dispose).toHaveBeenCalled()
  })

  it('times out a pending Core proof request and ignores its late response', async () => {
    vi.useFakeTimers()
    const lateResponse = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(lateResponse.promise)
    const createSession = vi.fn<() => RpcStub<CybernestConnectionBootstrapApi>>()
    const owner = makeOwner(fetch, createSession)

    const connecting = owner.start()
    await vi.advanceTimersByTimeAsync(PROOF_ATTEMPT_TIMEOUT_MS)
    await expect(connecting).resolves.toBeUndefined()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    lateResponse.resolve(jsonResponse(200, { proof: 'fixture-proof' }))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(createSession).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight Core proof request when stopped and ignores its late response', async () => {
    const lateResponse = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(lateResponse.promise)
    const createSession = vi.fn<() => RpcStub<CybernestConnectionBootstrapApi>>()
    const owner = makeOwner(fetch, createSession)

    const connecting = owner.start()
    const request = fetch.mock.calls[0]![1]
    const signal = request?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    owner.stop()
    await expect(connecting).resolves.toBeUndefined()

    expect(signal?.aborted).toBe(true)
    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    lateResponse.resolve(jsonResponse(200, { proof: 'late-proof' }))
    await flushMicrotasks()

    expect(createSession).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('applies the finite Core proof deadline to response JSON parsing too', async () => {
    vi.useFakeTimers()
    const body = deferred<unknown>()
    const response = new Response(null, { status: 200 })
    response.json = vi.fn(() => body.promise)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    const createSession = vi.fn<() => RpcStub<CybernestConnectionBootstrapApi>>()
    const owner = makeOwner(fetch, createSession)

    const connecting = owner.start()
    await flushMicrotasks()
    expect(response.json).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(PROOF_ATTEMPT_TIMEOUT_MS)
    await expect(connecting).resolves.toBeUndefined()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('times out a pending native handshake and disposes a result that arrives later', async () => {
    vi.useFakeTimers()
    const lateResult = deferred<NativeProofResult>()
    const session = bootstrapSession(() => lateResult.promise)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(200, { proof: 'fixture-proof' }),
    )
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)
    const connecting = owner.start()
    await flushMicrotasks()
    expect(session.presentProof).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(PROOF_ATTEMPT_TIMEOUT_MS)
    await expect(connecting).resolves.toBeUndefined()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(session.dispose).toHaveBeenCalled()

    const root = authenticatedRoot()
    const result = proofResult(root.root)
    lateResult.resolve(result.result)
    await flushMicrotasks()

    expect(result.dispose).toHaveBeenCalled()
    expect(root.dispose).toHaveBeenCalled()
    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('invalidates a timed-out session before disposal can synchronously report it broken', async () => {
    vi.useFakeTimers()
    const lateResult = deferred<NativeProofResult>()
    const session = bootstrapSession(() => lateResult.promise, true)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(200, { proof: 'fixture-proof' }),
    )
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)

    const connecting = owner.start()
    await flushMicrotasks()
    expect(session.presentProof).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(PROOF_ATTEMPT_TIMEOUT_MS)
    await expect(connecting).resolves.toBeUndefined()
    await flushMicrotasks()

    expect(owner.getSnapshot()).toMatchObject({ status: 'stopped' })
    expect(session.dispose).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledOnce()

    const late = proofResult(authenticatedRoot().root)
    lateResult.resolve(late.result)
    await flushMicrotasks()
    expect(late.dispose).toHaveBeenCalledOnce()
  })

  it('withdraws a disconnected root before one fresh proof, and coalesces overlapping wake events', async () => {
    const rootA = authenticatedRoot()
    const rootB = authenticatedRoot()
    const resultA = proofResult(rootA.root)
    const resultB = proofResult(rootB.root)
    const proofB = deferred<Response>()
    const nativeResultB = deferred<NativeProofResult>()
    const sessionA = bootstrapSession(async () => resultA.result)
    const sessionB = bootstrapSession(() => nativeResultB.promise)
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { proof: 'proof-a' }))
      .mockReturnValueOnce(proofB.promise)
    const sessions = [sessionA, sessionB]
    const createSession = vi.fn(() => sessions.shift()!.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: rootA.root })
    const observed: ReturnType<typeof owner.getSnapshot>[] = []
    const unsubscribe = owner.subscribe(() => observed.push(owner.getSnapshot()))

    sessionA.break()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'connecting',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(rootA.dispose).toHaveBeenCalled()
    expect(resultA.dispose).toHaveBeenCalled()
    expect(sessionA.dispose).toHaveBeenCalled()
    expect(observed.at(-1)).toMatchObject({
      status: 'connecting',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(fetch).toHaveBeenCalledTimes(2)

    const firstWake = owner.wake()
    const secondWake = owner.wake()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledTimes(1)

    proofB.resolve(jsonResponse(200, { proof: 'proof-b' }))
    await flushMicrotasks()
    expect(sessionB.presentProof).toHaveBeenCalledExactlyOnceWith('proof-b')
    expect(owner.getSnapshot()).toMatchObject({
      status: 'connecting',
      authenticatedApi: null,
      serverConfig: null,
    })

    nativeResultB.resolve(resultB.result)
    await Promise.all([firstWake, secondWake])
    unsubscribe()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'authenticated',
      authenticatedApi: rootB.root,
      serverConfig: resultB.result.serverConfig,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledTimes(2)
    owner.stop()
    expect(resultB.dispose).toHaveBeenCalled()
    expect(sessionB.dispose).toHaveBeenCalled()
  })

  it('keeps a failed reconnect terminal after subsequent wake and broken notifications', async () => {
    vi.useFakeTimers()
    const root = authenticatedRoot()
    const result = proofResult(root.root)
    const session = bootstrapSession(async () => result.result)
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { proof: 'initial-proof' }))
      .mockResolvedValueOnce(jsonResponse(503, {}))
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated' })

    session.break()
    await owner.wake()
    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      reason: 'unavailable',
      authenticatedApi: null,
      serverConfig: null,
    })

    session.break()
    await owner.wake()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledOnce()
  })

  it('clears recovery eligibility after success and allows the next outage one fresh attempt', async () => {
    const roots = [authenticatedRoot(), authenticatedRoot(), authenticatedRoot()]
    const results = roots.map(({ root }) => proofResult(root))
    const allSessions = results.map(({ result }) => bootstrapSession(async () => result))
    const sessions = [...allSessions]
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      jsonResponse(200, { proof: `proof-${fetch.mock.calls.length + 1}` }),
    )
    const createSession = vi.fn(() => sessions.shift()!.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: roots[0]!.root })

    allSessions[0]!.break()
    await owner.wake()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: roots[1]!.root })

    allSessions[1]!.break()
    await owner.wake()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: roots[2]!.root })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(createSession).toHaveBeenCalledTimes(3)
    expect(roots[0]!.dispose).toHaveBeenCalledOnce()
    expect(results[0]!.dispose).toHaveBeenCalledOnce()
    expect(roots[1]!.dispose).toHaveBeenCalledOnce()
    expect(results[1]!.dispose).toHaveBeenCalledOnce()
    expect(allSessions[0]!.dispose).toHaveBeenCalledOnce()
    expect(allSessions[1]!.dispose).toHaveBeenCalledOnce()
    owner.stop()
    expect(roots[2]!.dispose).toHaveBeenCalledOnce()
    expect(results[2]!.dispose).toHaveBeenCalledOnce()
    expect(allSessions[2]!.dispose).toHaveBeenCalledOnce()
  })

  it('coalesces wake probes and replaces a root whose read does not answer in time', async () => {
    vi.useFakeTimers()
    const rootA = authenticatedRoot()
    const rootB = authenticatedRoot()
    const resultA = proofResult(rootA.root)
    const resultB = proofResult(rootB.root)
    const pendingWhoami = deferred<unknown>()
    rootA.whoami.mockReturnValue(pendingWhoami.promise)
    const sessionA = bootstrapSession(async () => resultA.result)
    const sessionB = bootstrapSession(async () => resultB.result)
    const sessions = [sessionA, sessionB]
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      jsonResponse(200, { proof: `proof-${fetch.mock.calls.length + 1}` }),
    )
    const createSession = vi.fn(() => sessions.shift()!.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()
    await vi.advanceTimersByTimeAsync(WAKE_PROBE_MIN_IDLE_MS - 1)
    await owner.wake()
    expect(rootA.whoami).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    const firstWake = owner.wake()
    const secondWake = owner.wake()
    expect(rootA.whoami).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(WAKE_PROBE_TIMEOUT_MS)
    await Promise.all([firstWake, secondWake])

    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: rootB.root })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(rootA.dispose).toHaveBeenCalledOnce()
    expect(resultA.dispose).toHaveBeenCalledOnce()
    expect(sessionA.dispose).toHaveBeenCalledOnce()

    pendingWhoami.resolve({ type: 'user', id: 'late-user' })
    await flushMicrotasks()
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: rootB.root })

    owner.stop()
    expect(rootB.dispose).toHaveBeenCalledOnce()
    expect(resultB.dispose).toHaveBeenCalledOnce()
  })

  it('disposes a late stale proof result and keeps the newer generation active', async () => {
    const lateA = deferred<NativeProofResult>()
    const rootA = authenticatedRoot()
    const rootB = authenticatedRoot()
    const resultB = proofResult(rootB.root)
    const sessionA = bootstrapSession(() => lateA.promise)
    const sessionB = bootstrapSession(async () => resultB.result)
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      jsonResponse(200, { proof: 'fixture-proof' }),
    )
    const sessions = [sessionA, sessionB]
    const createSession = vi.fn(() => sessions.shift()!.rpc)
    const owner = makeOwner(fetch, createSession)

    const startA = owner.start()
    await flushMicrotasks()
    expect(sessionA.presentProof).toHaveBeenCalledOnce()

    sessionA.break()
    const reconnecting = owner.wake()
    await flushMicrotasks()
    expect(sessionB.presentProof).toHaveBeenCalledOnce()

    await reconnecting
    expect(owner.getSnapshot()).toMatchObject({ status: 'authenticated', authenticatedApi: rootB.root })

    const resultA = proofResult(rootA.root)
    lateA.resolve(resultA.result)
    await startA

    expect(rootA.dispose).toHaveBeenCalled()
    expect(resultA.dispose).toHaveBeenCalled()
    expect(owner.getSnapshot()).toMatchObject({
      status: 'authenticated',
      authenticatedApi: rootB.root,
      serverConfig: resultB.result.serverConfig,
    })
  })

  it('stops local capabilities for logout and ignores later wake or stale socket events', async () => {
    vi.useFakeTimers()
    const root = authenticatedRoot()
    const result = proofResult(root.root)
    const session = bootstrapSession(async () => result.result)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(200, { proof: 'fixture-proof' }),
    )
    const createSession = vi.fn(() => session.rpc)
    const owner = makeOwner(fetch, createSession)

    await owner.start()
    owner.stop()

    expect(owner.getSnapshot()).toMatchObject({
      status: 'stopped',
      authenticatedApi: null,
      serverConfig: null,
    })
    expect(root.dispose).toHaveBeenCalled()
    expect(result.dispose).toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalled()

    session.break()
    await owner.wake()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})
