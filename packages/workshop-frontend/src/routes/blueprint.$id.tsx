import { createFileRoute } from '@tanstack/react-router'
import { useBlueprintReader, useCybernestSnapshot, useRpcContext } from '../RpcContext'
import BlueprintLandingPage from '../BlueprintLandingPage'

export const Route = createFileRoute('/blueprint/$id')({
  component: BlueprintRoute,
})

function BlueprintRoute() {
  const rpcContext = useRpcContext()
  const reader = useBlueprintReader()
  const snapshot = useCybernestSnapshot()

  if (!reader) {
    if (rpcContext?.mode === 'cybernest' && snapshot?.status === 'stopped') {
      return snapshot.reason === 'unauthenticated' ? (
        <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-kumo-base p-6 text-center">
          <p className="text-sm text-kumo-subtle">Sign in to Cybernest to open this blueprint.</p>
          <a href="/auth/login" className="text-sm font-medium text-kumo-brand hover:underline">
            Sign in
          </a>
        </div>
      ) : (
        <div className="flex min-h-full items-center justify-center bg-kumo-base p-6 text-center">
          <p role="alert" className="text-sm text-kumo-danger">
            Cybernest could not connect. Please try again later.
          </p>
        </div>
      )
    }
    return <div className="flex min-h-full items-center justify-center bg-kumo-base text-sm text-kumo-subtle">Loading blueprint…</div>
  }
  return <BlueprintLandingPage rpcStub={reader} />
}
