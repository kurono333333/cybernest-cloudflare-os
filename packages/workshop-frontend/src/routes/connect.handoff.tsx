import { createFileRoute, Navigate } from '@tanstack/react-router'
import ConnectHandoffPage from '../ConnectHandoffPage'
import { useRpcContext } from '../RpcContext'

export const Route = createFileRoute('/connect/handoff')({
  component: HandoffRoute,
})

function HandoffRoute() {
  const rpcContext = useRpcContext()
  return rpcContext?.mode === 'cybernest'
    ? <Navigate to="/" replace />
    : <ConnectHandoffPage />
}
