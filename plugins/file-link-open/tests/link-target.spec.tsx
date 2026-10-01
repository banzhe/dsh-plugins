// @vitest-environment jsdom
/**
 * The official renderer keeps the link's line inside its own component and
 * writes only the path to `title`, so these specs render that exact shape with
 * real React. A React or DSH change moving the fiber shape must fail here —
 * loudly — instead of silently dropping to "opens at the top".
 */
import * as React from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyContextTarget, lineOfFileLink } from '../src/client/target.ts'

// React 18 only suppresses its "not configured to support act(...)" warning
// when this flag is set; without it every `act` call below logs a false alarm.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = React

const FILE_LINK_CLASS = 'md_fileMention md_fileLink'

let container: HTMLDivElement | null = null
let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = ReactDOMClient.createRoot(container)
  act(() => { root?.render(element) })
  return container
}

// A `memo` wrapper whose `file` prop is consumed internally and never reaches
// an attribute — the shape the walk has to see through.
const MarkdownFileLink = React.memo(function MarkdownFileLink(props: {
  file: { path: string, line?: number }
  glyph?: boolean
  children?: React.ReactNode
}) {
  return (
    <button type="button" className={FILE_LINK_CLASS} title={props.file.path}>
      {props.glyph === true ? <svg /> : null}
      {props.children}
    </button>
  )
})

function renderFileLink(file: { path: string, line?: number }) {
  return render(<MarkdownFileLink file={file} glyph>source</MarkdownFileLink>)
}

function buttonOf(view: HTMLElement): HTMLButtonElement {
  const button = view.querySelector('button')
  if (button === null) throw new Error('no file-link button rendered')
  return button
}

describe('lineOfFileLink', () => {
  it('reads the line from the owning component, one hop above the button', () => {
    const button = buttonOf(renderFileLink({ path: 'src/a.ts', line: 24 }))
    expect(lineOfFileLink(button, 'src/a.ts')).toBe(24)
  })

  it('reads a range fragment’s first line, as the official parser already reduced it', () => {
    const button = buttonOf(renderFileLink({ path: 'docs/notes.md', line: 24 }))
    expect(lineOfFileLink(button, 'docs/notes.md')).toBe(24)
  })

  it('returns null for a link that named no line', () => {
    const button = buttonOf(renderFileLink({ path: 'src/a.ts' }))
    expect(lineOfFileLink(button, 'src/a.ts')).toBeNull()
  })

  it('accepts a decoded path that differs from the authored destination', () => {
    // The official renderer writes the DECODED path to `title`, and the fiber
    // carries the same decoded value, so spaces and CJK still match.
    const button = buttonOf(renderFileLink({ path: 'docs/My Notes 中文.md', line: 2 }))
    expect(lineOfFileLink(button, 'docs/My Notes 中文.md')).toBe(2)
  })

  it('returns null when the element carries no React fiber', () => {
    const button = buttonOf(renderFileLink({ path: 'src/a.ts', line: 24 }))
    const orphan = document.createElement('button')
    orphan.className = FILE_LINK_CLASS
    orphan.title = 'src/a.ts'
    expect(lineOfFileLink(orphan, 'src/a.ts')).toBeNull()
    // The real button still resolves, so the miss above is the orphan's.
    expect(lineOfFileLink(button, 'src/a.ts')).toBe(24)
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['not a number', Number.NaN],
    ['not a safe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('returns null for a %s line rather than a wrong jump', (_why, line) => {
    const button = buttonOf(renderFileLink({ path: 'src/a.ts', line }))
    expect(lineOfFileLink(button, 'src/a.ts')).toBeNull()
  })

  it('returns null when the nearest matching component belongs to another path', () => {
    const button = buttonOf(renderFileLink({ path: 'src/a.ts', line: 24 }))
    expect(lineOfFileLink(button, 'src/other.ts')).toBeNull()
  })

  it('rejects an unrelated ancestor that happens to carry a `file` prop', () => {
    // The walk requires file.path === title, so a card whose own `file` prop
    // differs must not win over the link's component.
    function DeliverableCard(props: { file: { path: string, line?: number }, children?: React.ReactNode }) {
      return <div data-card="1">{props.children}</div>
    }
    const view = render(
      <DeliverableCard file={{ path: 'CARD-LEVEL.ts', line: 999 }}>
        <MarkdownFileLink file={{ path: 'src/a.ts', line: 24 }} glyph>source</MarkdownFileLink>
      </DeliverableCard>,
    )
    const button = buttonOf(view)
    expect(button.getAttribute('title')).toBe('src/a.ts')
    expect(lineOfFileLink(button, 'src/a.ts')).toBe(24)
  })

  it('returns null when the only `file` prop belongs to an ancestor for another path', () => {
    function Card(props: { file: { path: string, line?: number }, children?: React.ReactNode }) {
      return <div data-card="1">{props.children}</div>
    }
    const view = render(
      <Card file={{ path: 'CARD-LEVEL.ts', line: 999 }}>
        <button type="button" className={FILE_LINK_CLASS} title="src/a.ts">source</button>
      </Card>,
    )
    // The plain button's fiber carries no `file` prop, and the card's differs
    // from the title, so nothing is accepted.
    expect(lineOfFileLink(buttonOf(view), 'src/a.ts')).toBeNull()
  })
})

describe('lineOfFileLink synthetic fibers', () => {
  // Real React never produces these shapes; they pin the walk's defensive
  // branches (a wrapper with an unrelated prop, a chain that never reaches the
  // component).
  function buttonWithFiber(key: string, first: unknown): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = FILE_LINK_CLASS
    button.title = 'src/a.ts'
    ;(button as unknown as Record<string, unknown>)[key] = first
    return button
  }

  function fiber(memoizedProps: unknown, parent?: unknown): Record<string, unknown> {
    return { memoizedProps, return: parent }
  }

  it.each([
    ['the props are null', fiber(null)],
    ['there is no `file` prop', fiber({ other: 1 })],
    ['`file` is null', fiber({ file: null })],
  ])('ignores a fiber whose %s', (_why, first) => {
    expect(lineOfFileLink(buttonWithFiber('__reactFiber$abc', first), 'src/a.ts')).toBeNull()
  })

  it('stops at the hop limit instead of walking the whole tree', () => {
    // A matching component one hop PAST the limit is not reached: the walk is
    // bounded so a rename cannot turn a right-click into a full-tree traversal.
    let chain: unknown = fiber({ file: { path: 'src/a.ts', line: 24 } })
    for (let i = 0; i < 8; i += 1) chain = fiber({ other: i }, chain)
    expect(lineOfFileLink(buttonWithFiber('__reactFiber$abc', chain), 'src/a.ts')).toBeNull()
  })

  it('tolerates a fiber whose return is not an object', () => {
    expect(lineOfFileLink(buttonWithFiber('__reactFiber$abc', fiber({ other: 1 }, 7)), 'src/a.ts')).toBeNull()
  })
})

describe('classifyContextTarget', () => {
  it('classifies a message file link with its line', () => {
    const view = renderFileLink({ path: 'src/a.ts', line: 24 })
    expect(classifyContextTarget(buttonOf(view))).toEqual({ path: 'src/a.ts', line: 24 })
  })

  it('classifies a link that named no line as null', () => {
    const view = renderFileLink({ path: 'src/a.ts' })
    expect(classifyContextTarget(buttonOf(view))).toEqual({ path: 'src/a.ts', line: null })
  })

  it('classifies from a descendant of the button, as a label click does', () => {
    const view = renderFileLink({ path: 'src/a.ts', line: 5 })
    const label = buttonOf(view).firstChild
    expect(label).not.toBeNull()
    expect(classifyContextTarget(label)).toEqual({ path: 'src/a.ts', line: 5 })
  })

  it('ignores the input area’s reference chips, which share the class', () => {
    const view = render(
      <button type="button" className={FILE_LINK_CLASS} data-ref-chip="file" title="@src/a.ts">
        src/a.ts
      </button>,
    )
    expect(classifyContextTarget(buttonOf(view))).toBeNull()
  })

  it('ignores a file button with no title', () => {
    const view = render(<button type="button" className={FILE_LINK_CLASS}>source</button>)
    expect(classifyContextTarget(buttonOf(view))).toBeNull()
  })

  it('ignores a file button with an empty title', () => {
    const view = render(<button type="button" className={FILE_LINK_CLASS} title="">source</button>)
    expect(classifyContextTarget(buttonOf(view))).toBeNull()
  })

  it('classifies a title-less image link from its fiber, as DSH 0.1.7-rc.2 renders one', () => {
    // rc.2 drops `title` for a previewed image link, so the path has to come
    // from the same `file` prop the line does. Without this the right-click
    // menu would silently fall back to the native one for every image link.
    const view = render(<MarkdownFileLink file={{ path: 'docs/shot.png', line: 7 }} glyph>shot</MarkdownFileLink>)
    const button = buttonOf(view)
    expect(button.getAttribute('title')).toBe('docs/shot.png')
    // The same component shape with the title attribute removed, as the
    // preview branch renders it.
    button.removeAttribute('title')
    expect(classifyContextTarget(button)).toEqual({ path: 'docs/shot.png', line: 7 })
  })

  it('still refuses a title-less button whose fiber carries no file prop', () => {
    function Plain(props: { children?: React.ReactNode }) {
      return <button type="button" className={FILE_LINK_CLASS}>{props.children}</button>
    }
    const view = render(<Plain>source</Plain>)
    expect(classifyContextTarget(buttonOf(view))).toBeNull()
  })

  it('does not accept an ancestor-only file prop once the title is gone', () => {
    // With no title the equality check cannot anchor the walk, so the fallback
    // takes the NEAREST file prop. An ancestor is farther than the button's own
    // component, but a button with no file prop of its own must not borrow one.
    function Card(props: { file: { path: string, line?: number }, children?: React.ReactNode }) {
      return <div data-card="1">{props.children}</div>
    }
    const view = render(
      <Card file={{ path: 'CARD-LEVEL.ts', line: 999 }}>
        <button type="button" className={FILE_LINK_CLASS}>source</button>
      </Card>,
    )
    expect(classifyContextTarget(buttonOf(view))).toBeNull()
  })

  it.each([
    ['null', null],
    ['a non-element target', { closest: undefined }],
    ['an unrelated element', document.createElement('div')],
  ])('returns null for %s', (_why, target) => {
    expect(classifyContextTarget(target as EventTarget | null)).toBeNull()
  })
})
