import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  CybernestConnectionBootstrapApi,
  ServerConfig,
} from '@gadgets/workshop-shared/api'

export type BlueprintReader = Pick<
  RpcStub<CybernestConnectionBootstrapApi>,
  'getBlueprint' | 'downloadBlueprint'
>

export type CybernestConnectionSnapshot =
  | {
      status: 'connecting'
      authenticatedApi: null
      serverConfig: null
    }
  | {
      status: 'authenticated'
      authenticatedApi: RpcStub<AuthenticatedApi>
      serverConfig: ServerConfig
    }
  | {
      status: 'stopped'
      reason: 'unauthenticated' | 'denied' | 'unavailable' | 'error'
      authenticatedApi: null
      serverConfig: null
    }

type StopReason = Extract<CybernestConnectionSnapshot, { status: 'stopped' }>['reason']

type NativeProofResult = Awaited<
  ReturnType<RpcStub<CybernestConnectionBootstrapApi>['presentProof']>
>

type ConnectionOwnerOptions = {
  fetch: typeof globalThis.fetch
  createSession: () => RpcStub<CybernestConnectionBootstrapApi>
}

type Attempt = {
  generation: number
  deadline: number
  controller: AbortController
  session: RpcStub<CybernestConnectionBootstrapApi> | null
  result: NativeProofResult | null
  phase: 'connecting' | 'authenticated'
  recovery: boolean
  task: Promise<void> | null
}

const PROOF_ATTEMPT_TIMEOUT_MS = 20_000
const WAKE_PROBE_TIMEOUT_MS = 10_000
const WAKE_PROBE_MIN_IDLE_MS = 15_000
const PROOF_PATH = '/os/connection-proof'

class AttemptTimeoutError extends Error {
  constructor() {
    super('Connection proof attempt timed out')
    this.name = 'AttemptTimeoutError'
  }
}

class AttemptCancelledError extends Error {
  constructor() {
    super('Connection proof attempt was cancelled')
    this.name = 'AttemptCancelledError'
  }
}

class ConnectionFailure extends Error {
  constructor(readonly reason: StopReason) {
    super('Connection proof was not accepted')
    this.name = 'ConnectionFailure'
  }
}

const disposeQuietly = (value: { [Symbol.dispose](): void } | null) => {
  if (!value) return
  try {
    value[Symbol.dispose]()
  } catch {
    // The peer may already have closed the capability.
  }
}

function responseFailureReason(status: number): StopReason {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'denied'
  if (status >= 500) return 'unavailable'
  return 'error'
}

function disposeProofResult(result: NativeProofResult | null) {
  if (result) disposeQuietly(result)
}

export function createCybernestConnectionOwner({ fetch, createSession }: ConnectionOwnerOptions) {
  const listeners = new Set<() => void>()
  let generation = 0
  let terminal = false
  let hasStarted = false
  let lastProvenAt = Date.now()
  let wakeProbe: Promise<void> | null = null
  let current: Attempt | null = null
  let snapshot: CybernestConnectionSnapshot = {
    status: 'connecting',
    authenticatedApi: null,
    serverConfig: null,
  }

  const getSnapshot = () => snapshot
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function publish(next: CybernestConnectionSnapshot) {
    snapshot = next
    listeners.forEach(listener => listener())
  }

  function isCurrent(attempt: Attempt) {
    return !terminal && current === attempt && attempt.generation === generation
  }

  function release(attempt: Attempt) {
    // Dispose the returned envelope first; it owns the nested authenticated capability.
    disposeProofResult(attempt.result)
    attempt.result = null
    disposeQuietly(attempt.session)
    attempt.session = null
  }

  function cancel(attempt: Attempt) {
    if (!attempt.controller.signal.aborted) attempt.controller.abort()
  }

  function waitFor<T>(
    attempt: Attempt,
    source: Promise<T>,
    onLateValue?: (value: T) => void,
    deadline = attempt.deadline,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        attempt.controller.signal.removeEventListener('abort', onAbort)
      }
      const settle = (finish: (value: never) => void, value: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        finish(value as never)
      }
      const onAbort = () => settle(reject, new AttemptCancelledError())

      if (attempt.controller.signal.aborted || !isCurrent(attempt)) {
        settle(reject, new AttemptCancelledError())
      } else {
        const remaining = Math.max(0, deadline - Date.now())
        timer = setTimeout(() => {
          if (settled) return
          settle(reject, new AttemptTimeoutError())
          // Stop fetch/body processing as soon as the shared attempt deadline expires.
          cancel(attempt)
        }, remaining)
        attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
      }

      source.then(
        value => {
          if (settled) {
            try { onLateValue?.(value) } catch { /* cleanup must not leak a late RPC result */ }
            return
          }
          settle(resolve, value)
        },
        error => settle(reject, error),
      )
    })
  }

  function stopAttempt(attempt: Attempt, reason: StopReason) {
    if (!isCurrent(attempt)) return

    // Invalidate callbacks before abort/disposal: either can synchronously report a broken socket.
    terminal = true
    generation++
    current = null
    publish({
      status: 'stopped',
      reason,
      authenticatedApi: null,
      serverConfig: null,
    })
    cancel(attempt)
    release(attempt)
  }

  function stopWithReason(reason: StopReason) {
    if (terminal) return
    terminal = true
    generation++
    const previous = current
    current = null
    publish({
      status: 'stopped',
      reason,
      authenticatedApi: null,
      serverConfig: null,
    })
    if (previous) {
      cancel(previous)
      release(previous)
    }
  }

  function launch(attempt: Attempt): Promise<void> {
    const task = connectAndAuthenticate(attempt)
    attempt.task = task
    return task
  }

  function beginAttempt(recovery: boolean): Promise<void> {
    if (terminal) return Promise.resolve()

    const attempt: Attempt = {
      generation: ++generation,
      deadline: Date.now() + PROOF_ATTEMPT_TIMEOUT_MS,
      controller: new AbortController(),
      session: null,
      result: null,
      phase: 'connecting',
      recovery,
      task: null,
    }
    hasStarted = true
    current = attempt
    publish({ status: 'connecting', authenticatedApi: null, serverConfig: null })
    return launch(attempt)
  }

  function reconnectAfterBreak(attempt: Attempt): Promise<void> {
    if (!isCurrent(attempt)) return Promise.resolve()

    // Replace the generation before releasing capabilities; stale socket events cannot re-enter.
    const next: Attempt = {
      generation: generation + 1,
      deadline: Date.now() + PROOF_ATTEMPT_TIMEOUT_MS,
      controller: new AbortController(),
      session: null,
      result: null,
      phase: 'connecting',
      recovery: true,
      task: null,
    }
    generation = next.generation
    current = next
    publish({ status: 'connecting', authenticatedApi: null, serverConfig: null })
    cancel(attempt)
    release(attempt)
    return launch(next)
  }

  function onSessionBroken(attempt: Attempt) {
    if (!isCurrent(attempt)) return
    if (attempt.recovery) {
      stopAttempt(attempt, 'unavailable')
    } else {
      void reconnectAfterBreak(attempt)
    }
  }

  async function connectAndAuthenticate(attempt: Attempt): Promise<void> {
    try {
      const response = await waitFor(attempt, fetch(PROOF_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: attempt.controller.signal,
      }))
      if (!isCurrent(attempt)) return
      if (!response.ok) throw new ConnectionFailure(responseFailureReason(response.status))

      const body: unknown = await waitFor(attempt, response.json())
      if (!isCurrent(attempt)) return
      if (typeof body !== 'object' || body === null || !('proof' in body) || typeof body.proof !== 'string' || !body.proof) {
        throw new Error('Core did not return a connection proof')
      }

      const session = createSession()
      attempt.session = session
      session.onRpcBroken(() => onSessionBroken(attempt))

      const result = await waitFor(attempt, session.presentProof(body.proof), disposeProofResult)
      if (!isCurrent(attempt)) {
        disposeProofResult(result)
        return
      }
      attempt.result = result
      attempt.phase = 'authenticated'
      attempt.recovery = false
      lastProvenAt = Date.now()
      publish({
        status: 'authenticated',
        authenticatedApi: result.authenticatedApi,
        serverConfig: result.serverConfig,
      })
    } catch (error) {
      if (!isCurrent(attempt)) return
      const reason = error instanceof ConnectionFailure
        ? error.reason
        : error instanceof AttemptCancelledError
          ? 'error'
          : error instanceof AttemptTimeoutError
            ? 'unavailable'
            : 'error'
      stopAttempt(attempt, reason)
    }
  }

  function start(): Promise<void> {
    if (terminal) return Promise.resolve()
    if (current?.phase === 'authenticated') return Promise.resolve()
    if (current?.task) return current.task
    if (current) return launch(current)
    return beginAttempt(hasStarted)
  }

  function wake(): Promise<void> {
    if (terminal) return Promise.resolve()
    if (wakeProbe) return wakeProbe
    if (current?.phase === 'authenticated') {
      if (Date.now() - lastProvenAt < WAKE_PROBE_MIN_IDLE_MS) return Promise.resolve()
      const attempt = current
      const root = attempt.result?.authenticatedApi
      if (!root) return Promise.resolve()

      const task = (async () => {
        try {
          await waitFor(
            attempt,
            root.whoami(),
            undefined,
            Date.now() + WAKE_PROBE_TIMEOUT_MS,
          )
          if (isCurrent(attempt)) lastProvenAt = Date.now()
        } catch {
          if (isCurrent(attempt)) {
            await reconnectAfterBreak(attempt)
          } else if (current?.phase === 'connecting' && current.task) {
            await current.task
          }
        }
      })()
      wakeProbe = task
      void task.finally(() => {
        if (wakeProbe === task) wakeProbe = null
      }).catch(() => {})
      return task
    }
    if (current?.task) return current.task
    if (current) return launch(current)
    return beginAttempt(hasStarted)
  }

  function getBlueprintReader(): BlueprintReader | null {
    return terminal ? null : current?.session ?? null
  }

  function stop() {
    stopWithReason('unauthenticated')
  }

  return {
    getSnapshot,
    subscribe,
    getBlueprintReader,
    start,
    wake,
    stop,
  }
}

export type CybernestConnectionOwner = ReturnType<typeof createCybernestConnectionOwner>
