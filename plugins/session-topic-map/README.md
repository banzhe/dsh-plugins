# @banzhe/dsh-session-topic-map

A topic map in the right sidebar: the current Session's conversation read as a branching graph of topics, where picking a box jumps to the reply it came from.

[中文版](./README.zh-CN.md)

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

> [!WARNING]
> **`dsh-session-topic-map` is in unstable development.** It is suitable for development and testing; **do not depend on it in production.**
>
> - **Compatibility is not guaranteed.** The graph structure and the Host/Client interfaces may change between versions.
> - **Model calls may fail.** A model response can be unavailable or fail structured parsing; the panel shows the failure and you retry it, which needs a fresh confirmation.
> - **Local data is migrated, not guaranteed to stay readable.** Stored maps are upgraded to the current format on read (for example, the version-2 graph is rewritten as version 3), but old data is not promised to remain compatible across future versions.
> - **Jumps are turn-level and limited to the rendered view.** A box jumps to the turn it came from, not to a specific message, and only turns currently rendered in the transcript can be located.

## Features

- A session-scoped page tab (`kind: session-topic-map`) in the right sidebar, with a guide entry.
- Lists the models the profile advertises and analyzes the conversation with the one you pick. Nothing is sent to a model until you press **Start analysis**; the Host refuses an analysis request that does not carry your confirmation.
- Reads only the messages appended since the last finished analysis, so a second run continues where the first stopped and never re-bills the same conversation.
- Keeps the map current by itself once you confirm: a backlog drains in consecutive batches, and a quiet conversation is checked again every two seconds, which never reaches a model.
- Pausing, switching Session, or leaving the tab stops it; resuming always needs a fresh confirmation.
- Top-to-bottom topic lanes: each topic has a fixed horizontal lane, a reply that advances multiple topics creates independent topic nodes side by side on the same row, and each node links downward to the next step of that same topic.
- Stores one map per Session in the plugin's own storage domain, so switching Sessions or restarting `dsh web` keeps each map.
- Clicking a box jumps to the turn it came from through the transcript's `data-chat-turn` marker and outlines that row, without changing the chat renderer. The jump works only for turns rendered in the current view.
- Does not write to the Session log, and does not call a model for any other purpose.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-topic-map
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-topic-map build
dsh plugin --profile web add ./plugins/session-topic-map
```

Then restart `dsh web`. The Client half hot-reloads when a watcher rewrites `lib/client.js`; host changes still need a restart. Rebuild `lib/` after source changes.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-session-topic-map
```

## Docs

Implementation notes: [`docs/plugins/session-topic-map.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-topic-map.md).

## License

MIT