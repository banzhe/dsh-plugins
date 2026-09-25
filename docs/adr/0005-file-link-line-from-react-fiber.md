# File-link line number from the React fiber

A markdown file link may name a line — `[source](src/a.ts#L24)`, or the range form `#L24-L30`. The official renderer parses that fragment, but it consumes the result inside its own component: `MarkdownFileLink` passes `{ line }` to the `openFile` delegate and never writes the line to an attribute. At the time of this decision the button's `title` carried the path and nothing else, so the DOM supplied the path but never the line. (That premise was later weakened — see the amendment below.)

The line is read from the link button's React fiber instead — the nearest ancestor fiber whose `memoizedProps.file` is a destination object whose `path` equals the button's own `title`. Measured against the installed renderer: one hop from the button to `MarkdownFileLink` (React `memo`, fiber tag 15). Requiring the path to match the button's `title` is what makes it exact rather than a guess: an unrelated ancestor that happens to own a prop named `file` (a deliverable card, for instance) is rejected, and the walk is bounded to 6 hops so a rename cannot turn a right-click into a tree traversal.

This supersedes nothing; it extends the trade accepted in [0004](0004-session-id-from-react-fiber.md), which read a session id from a row's fiber for the same reason — exactness instead of parsing locale copy. The cost is the same: React internals (`__reactFiber$` plus a per-page random suffix, `memoizedProps`, `return`). A React or DSH major that moves them degrades to "the editor opens at the top of the file", never to a wrong launch, and four checks make that failure visible as a red test rather than a silent regression:

- `tests/link-target.spec.tsx` renders the official `MarkdownFileLink` shape with real React in jsdom and pins the walk, its hop limit, the `path === title` guard, the title-less path fallback, and the rejection of invalid line values.
- `tests/official-renderer-contract.spec.ts` asserts the premise against the **installed** official renderer artifact: `MarkdownFileLink` still destructures `file`, still carries `file.path` on the button (now conditionally), still reads `file.line`, and still renders a `button`.
- `tests/official-launch-contract.spec.ts` asserts the other premise against the **installed** official resolver: `launchResolved` substitutes the catalog's `{path}` inside the line-bearing argv rather than appending a second path, which is what makes `--goto <file>:24` one argument.
- `tests/launch-args.spec.ts` pins the per-editor CLI spellings the host substitutes, and that every launchable editor except Android Studio has one.

## Amendment: `title` became conditional in DSH 0.1.7-rc.2

DSH `0.1.7-rc.2` added an inline image preview to the same component and changed the attribute to `title={src === undefined ? file.path : undefined}`. A glyph-rendered link whose path classifies as an image therefore carries **no** `title` whenever `fileImages` resolves a preview, which `ui-chat` always supplies. Two things followed, and both are implemented rather than assumed:

- The client's context-menu selector no longer requires `[title]`; it matches `button[class*="fileMention"]:not([data-ref-chip])`. Requiring the attribute would have silently dropped every image link back to the native menu.
- A title-less button resolves its path from the fiber, but **only** from the component whose name is `MarkdownFileLink`. Taking the nearest `file` prop instead would be a wrong launch, not a degraded one: `PresentedFileCard` in ui-deliverables owns a `file` prop of its own (`{path, description, seq, index}`), so an ancestor-anchored rule would open the enclosing card's path. The component name is the discriminator, and it is a pinned contract — `tests/official-renderer-contract.spec.ts` asserts `function MarkdownFileLink(` exists in the installed artifact.

The line walk is unchanged: it still anchors on `file.path === title`, and a title-less link still yields its line because the same fiber prop supplies both. If a future release renames the component, image links degrade to the native menu and titled links keep working.

Two consequences are explicit. `androidstudio` is deliberately absent from the line-argv table because `studio64.exe` documents no line flag, and every macOS editor resolves to `open -a <bundle>`, whose appended-argument form cannot carry a line — those open at the top rather than being launched with a `file:24` path that names nothing. The host half refuses such launchers structurally (`supportsLaunchArgs`), so the client never has to know which platform it is on.

The same seam carries a second, unrelated preference: [the window-reuse switch](0006-reuse-the-running-editor-window.md) rides the identical argv rewrite, because the official resolution is the only place this plugin can influence how a launch lands.
