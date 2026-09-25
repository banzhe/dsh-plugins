/**
 * The contract this plugin's line support actually depends on, read from the
 * INSTALLED official renderer artifact.
 *
 * The walk in `src/client/target.ts` needs `MarkdownFileLink` to keep the parsed
 * destination on its own props (`file`, carrying `path` and `line`) and to never
 * put the line in an attribute. That is not a documented public API — it is a
 * fact about the shipped component — so it is asserted against the installed
 * build rather than against a copy of its source.
 *
 * DSH 0.1.7-rc.2 made `title` conditional (`title={src === undefined ? file.path
 * : undefined}`), so a glyph-rendered image link carries no title once the
 * inline preview resolves. The path therefore comes from the same fiber prop as
 * the line, and this file pins both halves of that contract.
 *
 * Reading the built file (instead of importing it) is deliberate: the artifact
 * pulls a ~30-package tree that this standalone package does not install. A
 * textual contract check needs none of that and still fails the moment the
 * official component stops passing `file` through.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** The installed official renderer's built entry, resolved as the shell resolves it. */
function officialRendererSource(): string {
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'))
  return readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
}

/** The official `MarkdownFileLink` component's body, or null when it moved. */
function markdownFileLinkBody(source: string): string | null {
  const start = source.indexOf('function MarkdownFileLink(')
  if (start < 0) return null
  // Bounded at the next top-level function: the component's own end. A fixed
  // character window would start missing its tail the moment the official build
  // inserts a line, turning an unrelated patch into a red test.
  const end = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('installed official renderer contract', () => {
  const source = officialRendererSource()
  const body = markdownFileLinkBody(source)

  it('still defines MarkdownFileLink and destructures a `file` prop', () => {
    expect(body).not.toBeNull()
    // The walk reads `file.path`/`file.line` off this prop, so the parameter has
    // to keep the name and the position the built component carries.
    expect(body).toMatch(/function MarkdownFileLink\(\{\s*file\b/)
  })

  it('keeps the path on the button title for ordinary links, so the walk need not guess', () => {
    // The common case is unchanged: a non-image link writes its decoded path.
    expect(body).toMatch(/title:\s*src === void 0 \? file\.path : void 0/)
  })

  it('may omit the title for a previewed image link, which is why the path falls back to the fiber', () => {
    // 0.1.7-rc.2 behavior: `fileImages` resolves a preview for an image-classified
    // path, and the title is dropped so the preview owns the hover affordance.
    // `pathOfFileLink` covers this by reading the nearest `file` prop instead.
    expect(body).toMatch(/fileImages/)
    expect(body).toMatch(/title:\s*src === void 0 \? file\.path : void 0/)
  })

  it('still reads the line off that prop when opening', () => {
    // Mirror image of the walk: the official opener takes `file.line`.
    expect(body).toMatch(/file\.line/)
  })

  it('still marks the button with the fileMention and fileLink classes the selector matches', () => {
    expect(body).toMatch(/markdownCss\.fileMention/)
    expect(body).toMatch(/markdownCss\.fileLink/)
  })

  it('still renders a button rather than an anchor, which is why a fiber is needed', () => {
    expect(body).toContain('"button"')
  })

  it('still exposes parseFileLink so a line fragment yields a numeric line', () => {
    // The walk never parses the destination itself: the official parser decides
    // what counts as a line (`#L24`, `#L24-L30`), and it lives in the same build.
    expect(source).toContain('function parseFileLink(')
  })
})
