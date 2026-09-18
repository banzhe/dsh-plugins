# @banzhe/dsh-hover-archive

Web Client plugin: hovering a sidebar Session row and pressing `A` archives that Session. Meant for the `web` Profile.

## Install

```sh
dsh plugin --profile web add ./plugins/hover-archive
```

Rebuild `lib/` after source changes and refresh the GUI. Do not assume HMR. Adding the Bundle to `dsh.profile.bundles` requires a process restart.

## Gesture

- Pointer on a non-blank Session row, or that row's hover card.
- Unchorded physical `A` (`Shift+A` is ignored; Caps Lock `A` archives). Key repeat and IME composition are ignored.
- Steals `A` from the conversation composer (`[data-composer-input]`). Search, rename, and settings inputs keep the letter.

The session id is read from the row element's React fiber: the owning `SessionNodeItem` carries `props.node.id`. The gesture therefore needs no title matching, and duplicate titles archive the row actually under the pointer. The hover card is portaled outside the row, but its fiber chain returns to the same component, so the binding survives the pointer crossing onto it.

A blank New Session row is rejected (it has a real id but cannot be archived), and the id is checked against the Session list to exclude subagent-origin and already-archived Sessions.

Failures log `session archive rejected:` and do not toast. The built-in `⋯` Archive session menu is unchanged.

## Test

```sh
pnpm --filter @banzhe/dsh-hover-archive test
```

The suite drives real DOM events over fixture rows whose fiber chains encode the measured live shape (3 hops for a row, 4 for a portaled card), so a React or DSH upgrade that moves those internals fails the specs instead of silently disabling the gesture.
