// @vitest-environment jsdom
/**
 * The fiber walk that turns a DOM element into a session id.
 *
 * These specs pin the contract the whole plugin rests on: the id comes from
 * `props.node` on the owning row component, the blank provisional row is
 * rejected, and the tree's other row kinds (workspace headers, search hits) are
 * not mistaken for sessions.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  isForeignEditable, sessionIdAt, sessionIdFromNode, sessionRowById, sessionRowFrom,
} from '../src/client/dom.ts'
import {
  attachFiberChain, corruptFiberRow, cyclicFiberRow, hoverCard, rowWithLeadingKey,
  searchRowProps, sessionRow, sessionNodeProps, shapedRow, workspaceRowProps,
} from './fiber-fixture.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('sessionIdAt', () => {
  it('reads the id from the owning SessionNodeItem fiber', () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    expect(sessionIdAt(row)).toBe('session-1')
  })

  it('walks up from a descendant element', () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    expect(sessionIdAt(row.querySelector('span')!)).toBe('session-1')
  })

  it('reads the same id from a portaled hover card', () => {
    const card = hoverCard('session-1')
    document.body.append(card)
    expect(sessionIdAt(card)).toBe('session-1')
  })

  it('reaches the owner at the measured distance for rows and cards', () => {
    // The documented depths are measured, so the fixtures must not drift: a row's
    // owner is 3 hops up, a portaled card's is 4. Asserting the depth here fails
    // loudly if a fixture is built shallower than reality.
    const depthOf = (element: Element): number => {
      let fiber: { memoizedProps?: unknown; return?: unknown } | undefined =
        Reflect.get(element, Object.keys(element).find(key => key.startsWith('__reactFiber$'))!)
      let hop = 0
      while (fiber !== undefined && fiber !== null) {
        const props = fiber.memoizedProps as { node?: { id?: unknown } } | undefined | null
        if (props?.node?.id !== undefined) return hop
        fiber = fiber.return as typeof fiber
        hop += 1
      }
      return -1
    }
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    expect(depthOf(row)).toBe(3)
    expect(depthOf(hoverCard('session-1'))).toBe(4)
  })

  it('rejects the blank New Session row', () => {
    const row = sessionRow({ id: 'session-blank', blank: true })
    document.body.append(row)
    expect(sessionIdAt(row)).toBeUndefined()
  })

  it('returns undefined outside a React tree', () => {
    const row = document.createElement('div')
    document.body.append(row)
    expect(sessionIdAt(row)).toBeUndefined()
  })

  it('returns undefined when the fiber handle is not an object', () => {
    expect(sessionIdAt(corruptFiberRow())).toBeUndefined()
  })

  it('ignores a chain that carries no node props', () => {
    expect(sessionIdAt(shapedRow({ className: 'x' }))).toBeUndefined()
  })

  it('does not mistake a workspace header row for a session', () => {
    expect(sessionIdAt(shapedRow(workspaceRowProps()))).toBeUndefined()
  })

  it('does not mistake a search-result row for a session', () => {
    expect(sessionIdAt(shapedRow(searchRowProps()))).toBeUndefined()
  })

  it('rejects a node without an id, a title, or a numeric updatedAt', () => {
    for (const node of [
      { title: 't', updatedAt: 1 },
      { id: '', title: 't', updatedAt: 1 },
      { id: 7, title: 't', updatedAt: 1 },
      { id: 's', updatedAt: 1 },
      { id: 's', title: 't' },
    ]) {
      expect(sessionIdAt(shapedRow({ node }))).toBeUndefined()
    }
  })

  it('skips a non-object props payload before reaching the node', () => {
    const row = document.createElement('div')
    attachFiberChain(row, [{}, null, sessionNodeProps({ id: 'session-1' })])
    document.body.append(row)
    expect(sessionIdAt(row)).toBe('session-1')
  })

  it('skips unrelated keys before the fiber handle', () => {
    // React's key is not necessarily first: an element carries many own keys,
    // and the lookup must scan past them rather than assume a position.
    const row = rowWithLeadingKey('session-1')
    document.body.append(row)
    expect(sessionIdAt(row)).toBe('session-1')
  })

  it('stops after the hop budget instead of looping a cyclic chain', () => {
    expect(sessionIdAt(cyclicFiberRow())).toBeUndefined()
  })
})

describe('sessionIdFromNode', () => {
  it('walks off a text node onto its element parent', () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const text = row.querySelector('span')!.firstChild!
    expect(sessionIdFromNode(text)).toBe('session-1')
  })

  it('returns undefined for a target outside the document tree', () => {
    expect(sessionIdFromNode(null)).toBeUndefined()
  })
})

describe('sessionRowFrom', () => {
  it('returns the row and its session id', () => {
    const row = sessionRow({ id: 'session-1' })
    document.body.append(row)
    const hit = sessionRowFrom(row.querySelector('span'))
    expect(hit?.row).toBe(row)
    expect(hit?.sessionId).toBe('session-1')
  })

  it('returns null without a target or without an enclosing treeitem', () => {
    const loose = document.createElement('div')
    document.body.append(loose)
    expect(sessionRowFrom(null)).toBeNull()
    expect(sessionRowFrom(loose)).toBeNull()
  })

  it('returns null for a blank New Session row', () => {
    const row = sessionRow({ id: 'session-blank', blank: true })
    document.body.append(row)
    expect(sessionRowFrom(row)).toBeNull()
  })
})

describe('sessionRowById', () => {
  it('finds the rendered row for an id', () => {
    const first = sessionRow({ id: 'session-1' })
    const second = sessionRow({ id: 'session-2' })
    document.body.append(first, second)
    expect(sessionRowById(SessionId('session-2'))).toBe(second)
  })

  it('returns null when no row carries that id', () => {
    document.body.append(sessionRow({ id: 'session-1' }))
    expect(sessionRowById(SessionId('session-nope'))).toBeNull()
  })

  it('skips tree rows that resolve to no session', () => {
    const header = document.createElement('div')
    header.setAttribute('role', 'treeitem')
    document.body.append(header, sessionRow({ id: 'session-1' }))
    expect(sessionRowById(SessionId('session-1'))).not.toBeNull()
  })

  it('skips a matching treeitem that is not an HTMLElement', () => {
    // An SVG `role="treeitem"` is an Element but not an HTMLElement.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('role', 'treeitem')
    document.body.append(svg)
    expect(sessionRowById(SessionId('session-1'))).toBeNull()
  })
})

describe('isForeignEditable', () => {
  it('keeps A inside text inputs, selects, and contenteditable', () => {
    for (const el of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
    ]) {
      document.body.append(el)
      expect(isForeignEditable(el)).toBe(true)
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editable.append(inner)
    document.body.append(editable)
    expect(isForeignEditable(inner)).toBe(true)
  })

  it('reports an element whose contentEditable is the editing state', () => {
    const el = document.createElement('div')
    // jsdom reflects the IDL attribute rather than implementing editing, so the
    // property is the state the plugin's `isContentEditable` check reads there.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    document.body.append(el)
    expect(isForeignEditable(el)).toBe(true)
  })

  it('yields the composer and anything outside an element', () => {
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    const inner = document.createElement('span')
    composer.append(inner)
    document.body.append(composer)
    expect(isForeignEditable(inner)).toBe(false)
    expect(isForeignEditable(null)).toBe(false)
  })
})
