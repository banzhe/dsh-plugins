# Serving the Web icon set from a plugin

The Web launcher artwork — favicon, maskable and touch icons, install manifest — is built into `@deepseek-ai/dsh-web-frontend/dist` and delivered from there. Changing it means changing the DSH source, rebuilding the frontend, repackaging the desktop application and reinstalling it; a machine that has no checkout cannot take part at all, and an installed package cannot be patched in place without breaking its signature. The two source commits that set today's artwork (`4ecbce64a7`, `54d77b2b63`) are the reference for what the running surface should show.

`@banzhe/dsh-web-icons` takes that surface over at runtime: it snapshots the eight files of `apps/web/public` into the Bundle and claims their pathnames with `webServer` **exact** routes.

**Why exact routes and not an index rewrite.** The webserver matches a named route before the fallback seat that serves the built directory (`packages/host/webserver/src/index.ts`, the `match()` lookup ahead of `fallback`), so a route replaces the dist's copy instead of competing with it, and it does so before the document is parsed. Routes must be distinct, so a composition that also claims one of these paths fails activation loudly rather than silently serving whichever registered last. The structured index-injection rows were the other candidate; they would have to append a second `<link rel="icon">` and leave the winner to the browser's tie-breaking, and the tap form does not run at all for the desktop shell's window.

**Why the bytes travel inside the Bundle.** [0001](0001-monorepo-of-independent-bundles.md) and the workspace's plugin guardrails forbid a Bundle from depending on a DSH checkout. Serving straight out of `apps/web/public` would make the artwork depend on one machine's directory layout, and would break the moment the harness is upgraded or the checkout moves.

**Why there is no client half.** The icon requests are issued by the browser chrome itself, before and independently of page code, so a DOM rewrite would show the dist artwork first and then correct it — and it would need a client bundle whose assets cannot be fetched as siblings ([0009](0009-css-as-files.md)) for no gain.

**Why `no-cache` with a weak validator.** The maskable set is hundreds of kilobytes; `no-store` would re-download it on every navigation. `cache-control: no-cache` plus `ETag: W/"<size>-<mtime>"` makes a warm client pay one 304, while a re-synced snapshot (a copy, which moves the mtime) is picked up on the next navigation with no Host restart. The validator is derived from the file's identity, so a conditional request and a HEAD cost one `stat` and no read at all; only a response that actually carries bytes reads the file.

**What it deliberately does not claim.** `favicon.svg` stays retired: the source removed that mark and the harness's own build test requires the dist not to ship it, so serving it here would undo a decision that was made on purpose.

## Boundaries

- **The Desktop application window is not this surface.** The shell answers seven of these eight pathnames for its own `dsh-app://app/` window before a request reaches the Host, so those seven are invisible inside the application window; the browser origin reported as `DSH_WEB_URL` is what changes. `/favicon-dark.svg` is the one row the shell leaves to the Host — and also the one row nothing references. Dropping that row would make the boundary claim unconditional; it is kept because the row is what makes the snapshot a complete copy of the source icon set.
- **Nothing outside the page.** Executable, taskbar, tray, installer, Dock and About icons are build-time artifacts; a plugin has no channel to them, which is why this decision covers the page icon set only.
- **An installed PWA shortcut keeps its cached icon** until it is reinstalled.
- **The sidebar brand mark is a different mechanism.** It is the `sidebar.brand.mark` slot occupant, replaceable by a client plugin, and is not part of this set.

## Costs accepted

- The repository now carries ~445 KB of artwork it does not author, and drifts from the source until someone re-runs the copy documented in the Bundle's README. `tests/assets.spec.ts` pins the manifest's shape and each file's signature — not hashes — so a re-sync that changes the icon set is noticed, and a re-sync that merely replaces artwork is not.
- The validator keys on size and mtime, so an edit that preserves both is indistinguishable from no edit. Copying rather than editing in place is what the README asks for.
- A composition that already owns one of these pathnames fails to activate; the failure names the duplicate route, and the fix is to disable one of the two owners.

## Verified state at the time of writing

The running Host already served bytes identical to `apps/web/public` (all eight files, SHA256) — so on that machine the takeover changed the mechanism and the cache behavior, not the pixels. Its value is that the browser surface stops depending on whichever frontend build the installed package happens to carry, and that the artwork can be replaced from a Bundle instead of a rebuild.
