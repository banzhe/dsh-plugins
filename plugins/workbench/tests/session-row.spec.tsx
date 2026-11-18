// @vitest-environment jsdom
/**
 * The browsing list's Session row on its own: a row handed no second line draws
 * the cells it always has, unwrapped, and a row handed one stacks them over it.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionNodeItem } from '../src/client/rows/Rows.tsx'
import type { SessionNode } from '../src/client/tree.ts'

/** The locale seat, reduced to the labels the row reads: all empty, so a row's text is its own. */
const t = (() => '') as never

const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  id: 's1' as SessionId,
  title: 'Session one',
  blank: false,
  running: false,
  runningSubagentCount: 0,
  completed: false,
  pinned: false,
  archived: false,
  updatedAt: 0,
  ...over,
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []

afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots = []
  document.body.replaceChildren()
})

/** Mount one row; the slot seats are the shell's, stubbed to draw nothing. */
function mount(extra: { readonly secondaryLabel?: string } = {}): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const ignore = (() => undefined) as never
  act(() => {
    root.render(createElement(SessionNodeItem, {
      node: node(),
      currentId: undefined,
      now: 0,
      onOpen: ignore,
      onRenameRequest: ignore,
      renderSlot: (() => null) as never,
      renderFactorySlot: (() => null) as never,
      useContextMenuTarget: (() => false) as never,
      useContextMenu: (() => ({ getTriggerProps: () => ({}) })) as never,
      useSessionAccess: (() => true) as never,
      t,
      ...extra,
    } as never))
  })
  const row = host.firstElementChild
  if (!(row instanceof HTMLElement)) throw new Error('the row drew no element')
  return row
}

describe('Session row', () => {
  it('draws its cells unwrapped when it carries no second line', () => {
    const row = mount()
    // Leading cell, title, trailing details, action strip: the row's own children.
    expect(row.children).toHaveLength(4)
    expect(row.textContent).toBe('Session one')
    expect(row.querySelectorAll('[data-row-key]')).toHaveLength(0)
  })

  it("stacks a second line under the row's own line when it carries one", () => {
    const row = mount({ secondaryLabel: 'alpha' })
    expect(row.children).toHaveLength(2)
    // The row's own cells keep their layout inside the first line.
    expect(row.children[0]?.children).toHaveLength(4)
    expect(row.children[0]?.textContent).toBe('Session one')
    expect(row.children[1]?.textContent).toBe('alpha')
    // The second line is a label, not a row.
    expect(row.querySelectorAll('[data-row-key]')).toHaveLength(0)
  })
})
