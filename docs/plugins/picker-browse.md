# picker-browse — implementation notes

Moved out of the plugin’s README, which now covers only features and installation.

## What the fork is

`plugins/picker-browse/src/` is a read-only copy of `packages/client/ui-directory-picker-browse` from DeepSeek Harness `my_dev @ 3a01e5a`:

| File | Origin |
|---|---|
| `src/client/DirectoryBrowser.tsx` | the shipped dialog, plus the drive row |
| `src/client/DirectoryBrowser.module.css` | the shipped sheet, plus three drive-row rules |
| `src/client/flow.ts` | the shipped flow occupant, plus the `probeDrives` member |
| `src/client/index.ts` | the shipped browser half, plus two dictionary keys per locale |
| `src/index.ts` | the shipped inert node half, plus a `name` export |
| `src/client/drives.ts` | new: the drive letters, path-to-drive, and the probe |

Neither the Host backend (`dsh-host-directory-picker-browse`, the `ctx.directoryPicker` seam) nor the Workspace UI that declares the two holes is copied or changed: this Bundle is a client-only replacement for one row.

## The drive row

`drives.ts` owns the facts; `DirectoryBrowser.tsx` owns when they are read and what a press means.

- **Candidates.** `DRIVE_ROOTS` is `C:\` through `Z:\`, in that order — the row’s order is the letter’s order, never the Host’s answer order.
- **Probe.** `probeDrives(list, signal)` fans out over all 24 roots at once and keeps the ones that listed. A refusal is the absence signal: a letter with no drive, an unreadable root, or a refused capability all reject like any unreadable directory, so the dialog never has to tell those cases apart. The probe answers in candidate order and never rejects.
- **Gate.** The probe runs only after a level has landed whose separator is a backslash — the separator is read from the Host’s own home path (`separatorOf`), never from the client’s platform, so a remote POSIX Host keeps the row off and pays no listings for it. The probe runs once per open (a navigation re-renders but does not re-ask), and closing aborts the fan-out with the dialog.
- **Press.** A drive button calls the same `navigate()` an Enter-submitted path calls, with the root as its argument: the editor closes, failures surface, and the landing is selection-anchored and two-pane away from the display root, exactly as a typed `F:\` lands.
- **Mark.** The drive holding the displayed level (`driveOfPath` of `child ?? parent`) carries `aria-current="true"` and the selection pill fill the Miller rows use; the mark survives the inert state the nested create dialog imposes.
- **Layout.** `.driveRow` wraps rather than scrolls, so 24 buttons grow the header downwards instead of pushing the path bar past the 680px card. Colors are the dialog’s own semantic aliases (`label-secondary`/`label-primary`/`interactive-bg-active`), so both themes read correctly with no literal colors.

### Copy

The row adds two keys to the existing `directory-browser` namespace, in all eight shipped dictionaries: `browser.drives` (the group label) and `browser.drive` (`{name}` — each button’s accessible name, so a screen reader hears "Drive C:" rather than a bare "C:"). The namespace name is unchanged because the shipped row is disabled wherever this Bundle runs, and one namespace has one owner.

## Adaptations the fork needed

1. **Package identity.** Name `@banzhe/dsh-picker-browse`, loader id `picker-browse-personal`, devkit `clientBundle` build, `dsh` block with `client.platform: web` and the same four `client.inject` edges. The build resolves `react`, `clsx` is inlined, and `@deepseek-ai/dsh-client-ui-primitives` comes from the shell’s module table, so nothing else changed in the browser half.
2. **Peer ranges.** `@deepseek-ai/*` peers are caret ranges matching the DSH release this fork was built against, per this repo’s rule; the copied manifest’s `workspace:*`/`workspace:~` specifiers cannot be published.
3. **`probeDrives` on the dialog’s props.** The dialog is a pure consumer of an injected face, so the fan-out arrives as one more member (`probeDrives`) instead of the dialog reaching for `uiWorkspace` itself. The upstream component spec’s `mount()` helper gained `probeDrives: async () => []`; its Host answers POSIX paths, so the row never appears there and the row’s own spec file covers it.
4. **`@deepseek-ai/dsh-client-test-runtime` is not installed here.** The flow spec upstream ran on it (live slot registry, live locale runtime, pinned browser languages). The fork ships `tests/slots-double.ts` and `tests/locale-double.ts` instead, reproducing only the contracts the plugin depends on: declaration-scoped `inject` on the caller’s fiber, single-occupant `register` with the registry’s own error text, transactional iterables, a failed deferred setup on the fail-loud channel, one dictionary owner per namespace and locale, and `bind` resolving at call time. The locale double opens in `zh`, the language the shipped defaults assert.
5. **`ui-primitives` stand-in.** Importing the real library in a Node spec eagerly evaluates the katex/shiki/micromark tree, which this workspace does not install. `tests/ui-primitives-double.tsx` keeps the shipped modal’s observable behaviour (body portal, mask, Escape scoped to the topmost dialog by a layer stack, `data-modal-autofocus` initial focus, Tab containment, focus restoration) and the button and glyph shapes; only styling is dropped.
6. **One lint fix in the copied component spec.** `expect(cancels.map(button => button.disabled).sort())` gained an explicit comparator for this repo’s `typescript/require-array-sort-compare`; behaviour is identical.
7. **Coverage thresholds** are stated globally (90/85/90/90) rather than per file, because the copied dialog carries unreachable defensive arms the upstream 100%-per-file gate covered with `v8 ignore` comments. The measured suite sits at ~99.7% statements / ~98.9% branches.

## Test inventory

| Suite | Tests | Provenance |
|---|---|---|
| `tests/directory-browser.client.spec.tsx` | 82 | upstream, verbatim apart from the `mount()` prop and the sort comparator |
| `tests/client-flow.client.spec.tsx` | 11 | upstream 10 against the doubles, plus one new drive-probe case |
| `tests/drives.client.spec.tsx` | 9 | new: the letters, the probe, and the row’s rendering, press, mark, and absence |

## Known limitations

- **Windows only, by construction.** The row exists for a Host that lists Windows paths. A POSIX Host sees nothing, and a remote Windows Host seen from a POSIX client still gets the row, because the gate is the Host’s separator rather than the client’s platform.
- **The row appears when the whole fan-out settles.** DSH has no seam that enumerates drives, so the probe asks for 24 roots and renders the answers together. A mapped network drive that hangs instead of refusing therefore holds the row back until it answers or the dialog closes — the dialog itself is unaffected, since navigation runs on its own listing.
- **No refresh while the dialog stays open.** A drive mapped after the dialog opened appears on the next open; the probe is per open by design.
- **The row is not a tree.** It offers roots only; navigating inside a drive stays the Miller view’s business.
