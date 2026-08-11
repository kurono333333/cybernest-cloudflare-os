import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'

type RpcConnectionState = {
  readonly connectionLost: boolean
  readonly markConnectionRestored: () => void
}

export type RpcContextValue = RpcConnectionState & (
  | { readonly kind: 'public'; readonly stub: RpcStub<PublicApi> }
  | { readonly kind: 'authenticated'; readonly stub: RpcStub<AuthenticatedApi> }
)

// Context to provide the exact RPC capability and connection state throughout the app.
export const RpcContext = createContext<RpcContextValue | null>(null)

export function useRpcContext(): RpcContextValue {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error('useRpcContext must be used within RpcContext.Provider')
  return ctx
}

export function useRpcStub(): RpcStub<PublicApi> {
  const ctx = useRpcContext()
  if (ctx.kind !== 'public') {
    throw new Error('useRpcStub is only available for the PublicApi connection')
  }
  return ctx.stub
}

export function useConnectionLost(): boolean {
  return useRpcContext().connectionLost
}
