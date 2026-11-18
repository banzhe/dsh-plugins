/**
 * Stand-in for the shell's static `ui-primitives` library: the modal, the button,
 * and the six glyphs the picker composes.
 *
 * The real module eagerly evaluates the markdown/code-highlighting tree, which a
 * standalone Bundle does not install; the browser half resolves the real module
 * from the shell's module table, so only these Node specs need the stand-in. The
 * modal keeps the shipped behavior the upstream specs read — the body portal, the
 * mask, Escape and the layer stack that scopes it to the topmost dialog, initial
 * focus through `data-modal-autofocus`, Tab containment, and focus restoration —
 * and drops only its styling.
 */
import { useLayoutEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, KeyboardEventHandler, ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Layer = { readonly element: HTMLElement; readonly close: () => void }

const layers = new WeakMap<Document, Layer[]>()
const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/** Automatic focus without a lingering outline, as the shipped helper does. */
function focusWithoutRing(element: HTMLElement, options?: FocusOptions): void {
  element.setAttribute('data-dsh-automatic-focus', '')
  element.addEventListener('blur', () => { element.removeAttribute('data-dsh-automatic-focus') }, { once: true })
  element.focus(options)
}

/** Composition lifetime, so an IME keydown never closes a dialog. */
function observeComposition(document: Document): { guards(event: KeyboardEvent): boolean; dispose(): void } {
  let composing = false
  const start = (): void => { composing = true }
  const end = (): void => { composing = false }
  document.addEventListener('compositionstart', start, true)
  document.addEventListener('compositionend', end, true)
  return {
    guards: (event) => composing || event.isComposing,
    dispose: () => {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
    },
  }
}

/** Props the picker sets on the shipped modal. */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
  className?: string
  headless?: boolean
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>
}

/** The shipped modal: mask, Escape scoped to the topmost dialog, Tab containment, focus return. */
export function Modal({ open, onClose, title, children, className, headless, onKeyDownCapture }: ModalProps): ReactNode {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const pendingRestore = useRef<HTMLElement | undefined>(undefined)
  close.current = onClose
  useLayoutEffect(() => {
    const target = pendingRestore.current
    pendingRestore.current = undefined
    const element = dialog.current
    if (!open && element?.contains(element.ownerDocument.activeElement)
      && target?.isConnected && target.closest('[inert], [hidden]') === null) {
      focusWithoutRing(target, { preventScroll: true })
    }
    if (!open || element === null) return
    const document = element.ownerDocument
    const composition = observeComposition(document)
    const previous = document.activeElement
    const stack = layers.get(document) ?? []
    layers.set(document, stack)
    const layer: Layer = { element, close: () => { close.current() } }
    stack.push(layer)
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]')
      ?? element.querySelector<HTMLElement>(focusable) ?? element
    if (!element.contains(document.activeElement)) focusWithoutRing(initial)
    const keydown = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== layer || event.defaultPrevented || composition.guards(event)
        || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) close.current()
      }
      if (event.key !== 'Tab') return
      if (document.activeElement?.closest('[role="menu"]') != null) return
      const items = [...element.querySelectorAll<HTMLElement>(focusable)].filter(item => item.closest('[inert], [hidden]') === null)
      const first = items[0] ?? element
      const last = items.at(-1) ?? element
      const atEdge = event.shiftKey ? document.activeElement === first : document.activeElement === last
      if (document.activeElement === element || !element.contains(document.activeElement) || atEdge) {
        event.preventDefault()
        const next = event.shiftKey ? last : first
        next.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      composition.dispose()
      const wasTop = stack.at(-1) === layer
      stack.splice(stack.indexOf(layer), 1)
      document.removeEventListener('keydown', keydown)
      if (stack.length === 0) layers.delete(document)
      if (wasTop) {
        const restorable = previous instanceof HTMLElement && previous.isConnected ? previous : stack.at(-1)?.element
        if (restorable !== undefined) {
          pendingRestore.current = restorable
          focusWithoutRing(restorable)
        }
      }
    }
  }, [dialog, open])
  if (!open) return null
  return createPortal((
    <div role="presentation" onKeyDownCapture={onKeyDownCapture}>
      <div aria-hidden="true" data-testid="modal-mask" onClick={onClose} />
      <div
        ref={dialog}
        tabIndex={-1}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-headless={headless === true ? 'true' : undefined}
      >
        {children}
      </div>
    </div>
  ), document.body)
}

/** Props the picker sets on a shipped button. */
export type ButtonProps = {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

/** The shipped button atom, reduced to native attributes. */
export function Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest }: ButtonProps): ReactNode {
  return (
    <button type="button" data-variant={variant} data-size={size} className={className} {...rest}>
      {icon != null && <span data-testid="button-icon">{icon}</span>}
      {children}
    </button>
  )
}

/** One shipped glyph, reduced to the identity the dialog draws. */
function glyph(name: string) {
  return function Glyph({ size, className, ...rest }: {
    size?: number
    className?: string
    'aria-hidden'?: boolean | 'true' | 'false'
  }): ReactNode {
    return <span data-testid={name} data-size={size ?? undefined} className={className} {...rest} />
  }
}

/** The footer toggle's trailing check. */
export const IconCheckOutlineRegular = glyph('icon-check')
/** Breadcrumb and row chevron. */
export const IconChevronRightOutlineRegular = glyph('icon-chevron-right')
/** The path-edit pencil. */
export const IconEditOutlineRegular = glyph('icon-edit')
/** Closed-folder row glyph. */
export const IconFolderCloseRegular = glyph('icon-folder-close')
/** Open-folder selection glyph. */
export const IconFolderOpenRegular = glyph('icon-folder-open')
/** New-folder leading glyph. */
export const IconPlusOutlineRegular = glyph('icon-plus')
