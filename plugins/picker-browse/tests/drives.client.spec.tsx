// @vitest-environment jsdom
/**
 * The drive row this Bundle adds: the letters a Windows Host can list, the
 * probe that finds them, and what the dialog does with the answer — the row
 * shows only roots that listed, the drive holding the current level is marked,
 * and a press lands that root the way a typed `F:\` and Enter would.
 *
 * Failures are the absence signal: a letter with no drive behind it refuses
 * like any unreadable directory, so the dialog must silently drop it rather
 * than render a button that cannot work.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'
import { DRIVE_ROOTS, driveLabel, driveOfPath, probeDrives } from '../src/client/drives.ts'

afterEach(cleanup)

const HOME = 'C:\\Users\\u'
const DOCS = `${HOME}\\Documents`
const F_ROOT = 'F:\\'

/** A Windows-hosted tree: one home level, its child, and the F: root. */
function listingFor(path?: string): DirectoryListing {
  const asked = path ?? HOME
  const target = asked.length > 3 && asked.endsWith('\\') ? asked.slice(0, -1) : asked
  const tree: Record<string, DirectoryListing> = {
    [HOME]: {
      path: HOME,
      home: HOME,
      crumbs: [
        { name: 'C:\\', path: 'C:\\', hidden: false },
        { name: 'Users', path: 'C:\\Users', hidden: false },
        { name: 'u', path: HOME, hidden: false },
      ],
      entries: [{ name: 'Documents', path: DOCS, hidden: false }],
      truncated: false,
    },
    [DOCS]: {
      path: DOCS,
      home: HOME,
      crumbs: [
        { name: 'C:\\', path: 'C:\\', hidden: false },
        { name: 'Users', path: 'C:\\Users', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: DOCS, hidden: false },
      ],
      entries: [],
      truncated: false,
    },
    [F_ROOT]: {
      path: F_ROOT,
      home: HOME,
      crumbs: [{ name: F_ROOT, path: F_ROOT, hidden: false }],
      entries: [{ name: 'media', path: 'F:\\media', hidden: false }],
      truncated: false,
    },
  }
  const found = tree[target]
  if (found === undefined) throw new Error(`cannot list ${target}`)
  return found
}

function mount(drives: readonly string[], overrides: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) {
  const listDirectory = vi.fn(async (path?: string) => listingFor(path))
  const probeDrives = vi.fn(async () => drives)
  const props = {
    open: true,
    listDirectory,
    probeDrives,
    createDirectory: vi.fn(async (path: string, name: string) => `${path}\\${name}`),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    busy: false,
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}:${String(params.name)}`),
    ...overrides,
  }
  const view = render(<DirectoryBrowser {...props} />)
  return { view, props, listDirectory, probeDrives }
}

/** The drive row, once the probe has answered. */
async function driveRow(): Promise<HTMLElement> {
  return await screen.findByRole('group', { name: 'browser.drives' })
}

describe('drive letters', () => {
  it('offers C: through Z: as roots, and labels them without the separator', () => {
    expect(DRIVE_ROOTS).toHaveLength(24)
    expect(DRIVE_ROOTS[0]).toBe('C:\\')
    expect(DRIVE_ROOTS.at(-1)).toBe('Z:\\')
    expect(DRIVE_ROOTS.map(driveLabel)).toEqual(
      'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:`),
    )
  })

  it('reads the drive a listed path sits on, and nothing from a POSIX or relative path', () => {
    expect(driveOfPath('C:\\')).toBe('C:')
    expect(driveOfPath('f:\\media')).toBe('F:')
    expect(driveOfPath('D:/work/demo')).toBe('D:')
    expect(driveOfPath('c:')).toBe('C:')
    expect(driveOfPath('/home/u')).toBeNull()
    expect(driveOfPath('relative\\path')).toBeNull()
  })

  it('keeps the roots that listed and silently drops the ones that refused', async () => {
    const list = vi.fn(async (root: string): Promise<DirectoryListing> => {
      if (root === 'C:\\' || root === 'F:\\') return listingFor(root === 'F:\\' ? root : HOME)
      throw new Error(`cannot list ${root}`)
    })
    await expect(probeDrives(list, new AbortController().signal)).resolves.toEqual(['C:\\', 'F:\\'])
    expect(list).toHaveBeenCalledTimes(24)
  })

  it('probes every root at once rather than one after another', async () => {
    let inFlight = 0
    let peak = 0
    const list = async (): Promise<DirectoryListing> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      throw new Error('absent')
    }
    await expect(probeDrives(list, new AbortController().signal)).resolves.toEqual([])
    expect(peak).toBe(24)
  })
})

describe('the drive row in the dialog', () => {
  it('renders one button per listed root and none for an absent drive', async () => {
    mount(['C:\\', 'F:\\'])
    const row = await driveRow()
    const labels = within(row).getAllByRole('button').map(button => button.textContent)
    expect(labels).toEqual(['C:', 'F:'])
    expect(within(row).queryByRole('button', { name: 'browser.drive:D:' })).toBeNull()
  })

  it('marks the drive the listed level sits on', async () => {
    mount(['C:\\', 'F:\\'])
    const row = await driveRow()
    await waitFor(() => {
      expect(within(row).getByRole('button', { name: 'browser.drive:C:' }).getAttribute('aria-current')).toBe('true')
    })
    expect(within(row).getByRole('button', { name: 'browser.drive:F:' }).getAttribute('aria-current')).toBeNull()
  })

  it('navigates to a drive root on press: the same landing a typed path and Enter reach', async () => {
    const b = mount(['C:\\', 'F:\\'])
    const row = await driveRow()
    fireEvent.click(within(row).getByRole('button', { name: 'browser.drive:F:' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenLastCalledWith(F_ROOT, expect.any(AbortSignal)) })
    // The root lands as the single wide level and becomes the marked drive.
    await waitFor(() => {
      expect(within(row).getByRole('button', { name: 'browser.drive:F:' }).getAttribute('aria-current')).toBe('true')
    })
    expect(within(row).getByRole('button', { name: 'browser.drive:C:' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('listitem').textContent).toContain('media')
  })

  it('probes once per open, not once per navigation', async () => {
    const b = mount(['C:\\', 'F:\\'])
    const row = await driveRow()
    fireEvent.click(within(row).getByRole('button', { name: 'browser.drive:F:' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenLastCalledWith(F_ROOT, expect.any(AbortSignal)) })
    expect(b.probeDrives).toHaveBeenCalledTimes(1)
    // Closing and reopening asks again: a drive may have appeared meanwhile.
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await driveRow()
    await waitFor(() => { expect(b.probeDrives).toHaveBeenCalledTimes(2) })
  })

  it('renders no row at all for a Host that names no Windows roots', async () => {
    const probe = vi.fn(async () => [] as readonly string[])
    const posix: DirectoryListing = {
      path: '/home/u',
      home: '/home/u',
      crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'u', path: '/home/u', hidden: false }],
      entries: [],
      truncated: false,
    }
    render(
      <DirectoryBrowser
        open
        busy={false}
        listDirectory={async () => posix}
        probeDrives={probe}
        createDirectory={async () => ''}
        onOpen={() => {}}
        onClose={() => {}}
        t={key => key}
      />,
    )
    await waitFor(() => { expect(screen.getAllByRole('list')).toHaveLength(1) })
    expect(screen.queryByRole('group', { name: 'browser.drives' })).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})
