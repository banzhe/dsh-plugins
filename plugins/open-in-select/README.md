# @banzhe/dsh-open-in-select

Open the Session's workspace directory in a local application, from one compact control in the Session header.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- A compact "open in" control at the leading edge of the Session header's right-aligned utilities (`conversation.session.header.utilities`, order `-10`).
- The left half is the current application's icon alone; clicking it opens the Session's directory in that application straight away — no menu. The application's name is the button's tooltip and its accessible name, so nothing is lost to screen readers or hovering.
- The chevron lists every application the Host resolved; picking one opens it in that application and makes it the remembered default. That default survives a reload; without one, the first entry in the Host order is used.
- One available application means no chevron. No available application — or an `open-in-app` Host that cannot be reached — means no control at all, rather than a broken one.
- A launch in flight marks the control unavailable and drops further presses, so one gesture produces one launch request. The pointer and the hover feedback stay as they are instead of turning the control into a dead button.
- A refused launch or an unreachable Host raises one toast naming the failure; the statuses it distinguishes are listed in the implementation notes.
- Application names come from the Bundle's own id-to-name table, so an id it does not know is shown as-is instead of disappearing; icons load from the Host's icon route and fall back to a glyph of the same size. Labels and messages follow the app language (`open-in-select` namespace, zh/en).
- The Host's application list is read once per page, and the remembered application survives page reloads in local storage. Where storage is unavailable the choice simply stays in memory.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-open-in-select
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-open-in-select build
dsh plugin --profile web add ./plugins/open-in-select
```

Requires a `dsh web` restart. Rebuild `lib/` after later source changes and refresh the GUI; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-open-in-select
```

## Docs

Implementation notes: [`docs/plugins/open-in-select.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/open-in-select.md).

## Credits

The control's shape and its launch behaviour derive from the `ui-open-in-app` client package of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT © DeepSeek), rewritten against the Host's `open-in-app` routes without importing that package.

## License

MIT
