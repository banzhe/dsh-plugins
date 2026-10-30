# @banzhe/dsh-app-notification

Projects the finished-unread Session count onto the installed PWA's icon badge, and raises one system notification per Session that finishes while the page is open.

[中文版](./README.zh-CN.md)

A Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- Badge count follows the sidebar's green completion dots — ordinary Sessions that are finished and not yet opened — and is never higher than that count. `origin: 'subagent'` rows are excluded.
- A Session that is still waiting on a running subagent descendant — a child, or a grandchild behind an idle child — is neither counted nor announced. Its announcement lands once the last descendant settles.
- Archived Sessions never count and are never announced. Archiving a finished Session retracts it from the badge; restoring it re-counts it silently.
- Each newly finished ordinary Session raises one notification tagged `dsh-session-completed`; a run of completions replaces rather than stacks.
- Clicking a notification focuses this window, then opens that Session.
- First observation is state-only: a reload shows the current count and does not re-announce Sessions that finished while no page was watching.
- A General-settings row (`settings.general.item`, id `app-badge`) shows the live capability state and hosts the only user gesture that may call `Notification.requestPermission()`.
- Never requests permission on activation, never persists a toggle, and has no service worker or push — closed pages do not announce.
- A page with neither badging nor a `Notification` constructor still registers dictionaries and the settings row, so the readout can explain the silence.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-app-notification
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-app-notification build
dsh plugin --profile web add ./plugins/app-notification
```

Adding the Bundle to `dsh.profile.bundles` requires a process restart. Rebuild `lib/` after later source changes and refresh the GUI; do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-app-notification
```

## Docs

Implementation notes: [`docs/plugins/app-notification.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/app-notification.md).
