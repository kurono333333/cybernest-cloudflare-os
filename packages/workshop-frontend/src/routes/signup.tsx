import { createFileRoute } from '@tanstack/react-router'
import { CYBERNEST_MODE, useRpcContext } from '../RpcContext'
import { CF_ACCESS_MODE } from '../useAuth'
import { Navigate } from '@tanstack/react-router'
import SignupPage from '../SignupPage'

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
})

function SignupRoute() {
  const rpcContext = useRpcContext()
  // These modes use their external identity provider rather than Workshop signup.
  if (CF_ACCESS_MODE || CYBERNEST_MODE || rpcContext?.mode === 'cybernest') {
    return <Navigate to="/" replace />
  }
  if (!rpcContext || rpcContext.mode !== 'native') return null
  return <SignupPage rpcStub={rpcContext.stub} />
}
