// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

// Suppress effects so this test observes the render that happens before the bundle-load effect.
// That is the exact point where the empty-state flash can occur.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useEffect: () => undefined,
  }
})

vi.mock('@cloudflare/kumo', () => ({
  Banner: () => null,
  Loader: () => <span data-testid="gadget-loading">Loading</span>,
  Text: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@phosphor-icons/react', () => ({
  Sparkle: () => null,
}))

import GadgetUI from './GadgetUI'

describe('GadgetUI initial loading state', () => {
  let container: HTMLDivElement | undefined

  afterEach(() => {
    container?.remove()
    container = undefined
  })

  it('shows loading instead of the empty state before the first bundle load starts', () => {
    container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const gadget = {} as unknown as RpcStub<GadgetClient>

    flushSync(() => {
      root.render(<GadgetUI gadget={gadget} height="100px" />)
    })

    expect(container.textContent).not.toContain('No gadget UI yet')
    expect(container.querySelector('[data-testid="gadget-loading"]')).not.toBeNull()

    flushSync(() => root.unmount())
  })
})
