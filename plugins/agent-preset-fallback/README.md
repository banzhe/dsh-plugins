# @banzhe/dsh-agent-preset-fallback

Falls back to the deployment default agent preset when a stored or requested preset no longer exists, instead of failing session creation.

[中文版](./README.zh-CN.md)

A Host-side [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for every profile that creates sessions.

## Features

- A blank session that remembers an agent preset which was later removed still composes, on the deployment default.
- Covers both paths that resolve a preset: the session controller's `resolve` and the registry's internal `retain` dispatch.
- Rescues only `agent-preset/not-found` and `agent-preset/invalid` on a non-default id. `agent-preset/locked`, foreign errors, and the default id itself propagate untouched.
- Uninstalling restores the registry's own methods.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-fallback
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-fallback build
dsh plugin --profile web add ./plugins/agent-preset-fallback
```

Restart `dsh web` after installing or rebuilding — this Bundle has no client half, and its host half is loaded once at activation. Do not assume HMR.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-fallback
```

## Docs

Implementation notes: [`docs/plugins/agent-preset-fallback.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-fallback.md).
