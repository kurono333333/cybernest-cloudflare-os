import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter({ cybernestMode = false }: { cybernestMode?: boolean } = {}) {
  return createTanStackRouter({
    routeTree,
    basepath: cybernestMode ? '/workspace' : '/',
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
