import { createContext, useContext, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import type {
  BlueprintReader,
  CybernestConnectionOwner,
  CybernestConnectionSnapshot,
} from './features/cybernest/connectionOwner'

export const CYBERNEST_MODE = import.meta.env.VITE_CYBERNEST_MODE === 'true'

export type RpcContextValue =
  | { mode: 'native'; stub: RpcStub<PublicApi>; connectionLost: boolean }
  | { mode: 'cybernest'; owner: CybernestConnectionOwner }

export const RpcContext = createContext<RpcContextValue | null>(null)

const noChange = () => () => {}
const NO_CONNECTION: CybernestConnectionSnapshot = {
  status: 'stopped', reason: 'unavailable', authenticatedApi: null, serverConfig: null,
}
const getNoConnection = () => NO_CONNECTION

export function useRpcContext(): RpcContextValue | null {
  return useContext(RpcContext)
}

export function useRpcStub(): RpcStub<PublicApi> {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error('useRpcStub must be used within RpcContext.Provider')
  if (ctx.mode !== 'native') throw new Error('The public Workshop API is unavailable in Cybernest mode')
  return ctx.stub
}

export function useBlueprintReader(): BlueprintReader | null {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error('useBlueprintReader must be used within RpcContext.Provider')
  return ctx.mode === 'native' ? ctx.stub : ctx.owner.getBlueprintReader()
}

export function useCybernestSnapshot(): CybernestConnectionSnapshot | null {
  const ctx = useContext(RpcContext)
  const owner = ctx?.mode === 'cybernest' ? ctx.owner : null
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? noChange,
    owner?.getSnapshot ?? getNoConnection,
    owner?.getSnapshot ?? getNoConnection,
  )
  return owner ? snapshot : null
}

export function useConnectionLost(): boolean {
  const ctx = useContext(RpcContext)
  const snapshot = useCybernestSnapshot()
  return ctx?.mode === 'cybernest'
    ? snapshot?.status === 'connecting'
    : ctx?.mode === 'native' ? ctx.connectionLost : false
}
