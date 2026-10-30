# @banzhe/dsh-session-attention

A `shell.overlay` panel listing the Sessions that need attention — running, waiting on you, or finished-unread — behind a toggle.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** (and **desktop**) profile.

## Features

- **Toggle** — an always-present button in the frame's bottom-right corner, with a badge holding the number of listed Sessions. The badge always renders, `0` included.
- **Outer outline** on the toggle's own edge shows the highest-priority state, in this order:
  1. **waiting** — a listed Session holds a pending interaction (approval, question, plan review). Amber, and it holds still.
  2. **running** — work in flight. A 2px animated blue sweep around the edge.
  3. **unread** — finished while it was not the main view. Green, and it holds still.
- **Panel** — two sections, newest first:
  - **Running** (`进行中`) — the host reports the Session as running. Each row shows how long the current run has been going, counted from the Session's latest human prompt, so it survives a page reload; a new prompt restarts it.
    - **Running subagents** mount as an indented block under their parent row, one nesting level per delegation hop, each with its own duration counted from the start of its open turn.
    - A Session that is idle but has a running subagent — a child or a deeper descendant — is listed as a container row. Idle Sessions between it and the running work are container rows too, so the nesting stays intact and the running descendant sits at the bottom of it.
  - **Unread** (`未读`) — finished while it was not the main view, the same fact as the sidebar's green dot.
  - Each row wears the shipped `StateDot`: the running spinner, the green done dot, or the amber warning dot when that turn is blocked on you. Waiting for an answer is not activity, so no spinner.
- **Windows taskbar** — while listed Sessions are running and none are waiting or finished-unread, the desktop app's taskbar button shows the native indeterminate progress pulse. Waiting, unread, or an idle list clears it. Browsers and older shells do nothing.
- **Click a row** to show that Session as the main view; the panel closes behind it, and an unread reminder clears on its own.
- **Escape** and the panel's close button close it; the open state is in-memory (a reload starts closed).
- Every state color is read from `ui-theme` tokens; none is hand-picked. Under `prefers-reduced-motion` the sweep drops its animation and the ring stays.
- A row is listed while it is running itself or while anything below it is running: a session whose only activity is a nested subagent (grandchild or deeper) keeps its row, with the running descendant nested under the idle intermediates. Subagent children are not panel rows of their own and are not counted in the badge; blank New-Session placeholders are excluded.
- Archived Sessions never list, even while the host still reports them running or finished-unread, and they are not counted in the badge.
- Labels follow the app locale (`session-attention` namespace, zh/en).

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-attention
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-attention build
dsh plugin --profile web add ./plugins/session-attention
```

A new Bundle only reaches the client module graph at boot: restart DeepSeek Harness, then refresh the page. Rebuild `lib/` after later source changes. Do not assume HMR.

The **`desktop` profile is off limits to the CLI**: `dsh plugin --profile desktop …` refuses with *"profile "desktop" is managed exclusively by the Electron application"*. Add this Bundle there through the application's own plugin manager, or add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. The two profiles do not share a bundle list.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-session-attention
```

## Docs

Implementation notes: [`docs/plugins/session-attention.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-attention.md).
