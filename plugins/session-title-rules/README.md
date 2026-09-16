# @banzhe/dsh-session-title-rules

Rules-based Session title provider for the `web` Profile. It generates
`MMDD｜类型｜主题` from the conversation instead of the built-in
first-prompt provider's free-form title.

## Install

From this repo root, after `lib/` exists:

```sh
dsh plugin --profile web add ./plugins/session-title-rules
```

Rebuild `lib/` after source changes. Adding the Bundle to `dsh.profile.bundles`
requires a `dsh web` restart. Sessions created after the restart are titled by
this provider; a Session that already carries a title keeps it, because nothing
calls `sessionTitle.refresh()`.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-session-title-rules
```

## What it replaces

The `dsh-base` layer contributes row `session-title-llm`
(`@deepseek-ai/dsh-session-title-first-prompt-llm`). This Bundle's
`cordis.patch.yml` disables that row and inserts its own — the title service
holds exactly one provider slot, so a second registration throws and the
built-in cannot be left enabled. Disabling a row another layer owns is broader
than "insert only this Bundle's Loader rows"; that is deliberate here, and
removing the Bundle restores the built-in row. The decision is recorded in
[`docs/adr/0003`](../../docs/adr/0003-bundle-disables-base-title-provider.md).

## The rules it encodes

- Format: `MMDD｜类型｜主题`, e.g. `0916｜研究｜会话标题插件接缝`.
- `MMDD` is computed in code from the Session header's `createdAt`, converted to
  `Asia/Shanghai` — never `updatedAt`, and never the model's own idea of the
  date. The provider overwrites any date the model wrote.
- `类型` is the closed set 功能 / 设计 / 修复 / 优化 / 发布 / 探索 / 文档 / 研究.
- `主题` is distilled from the actual messages, never repeats the project name,
  and stays short enough for the sidebar (6–14 CJK characters, ≤ 8 English words).
- Topic language follows the conversation; mixed Chinese/English uses Chinese.
- When the messages do not identify a topic, the model answers `UNCHANGED`; the
  revision then fails, so the service warns and the current title stands instead
  of a guess.

Two of the requested rules need no prompt line: a user-renamed title
already pins the Session, so automatic generation stops scheduling, and a
provider can append nothing but `session/title` — project name, content,
membership, ordering, pinning, and archiving are structurally out of reach.

## Behaviour and cost

- `automatic: 'first-prompt'`: the title is derived once, from the Session's
  first eligible human message — one auxiliary model call (`maxTokens: 64`) and
  one *provider* `session/title` event per Session (the service appends its
  deterministic fallback first). Change `automatic` in `src/index.ts` to
  `'all-prompts'` to re-derive the topic on every user message instead —
  subagent Sessions would then be titled too, because `all-prompts` has no
  parent-session check.
- The recorded provenance is `source.provider = 'session-title-rules'` with the
  auxiliary route as `model`; nothing records that the date prefix was forced.
- Unlike the shipped providers this one appends no log-only
  `session/title-llm-request` audit row and never reuses
  `@deepseek-ai/dsh-session-title-llm` (whose system prompt is private), so the
  auxiliary request is not reconstructable from the log.
- Routing follows the Session's logged `request/header` route. Explicit
  `ctx.sessionTitle.refresh()` before any header exists has no route, so the
  provider fails and the deterministic fallback stays.
- Under this cadence, subagent and fork children are never titled:
  `first-prompt` schedules only for a top-level Session
  (`header.parentSession === undefined`), and a fork child inherits its parent's
  title through the seed.

## Fixed policy

No Loader `config` (the row carries none), so the caps below live in
`src/index.ts`: `maxOutputTokens: 64`, `timeoutMs: 60000`,
`maxInputBytes: 6000`, at most 8 messages (first + 7 most recent), 400
characters per message. Over-cap input drops the oldest messages; the accepted
title is finally normalized and truncated to `maxTitleBytes` by the service.

Failures warn (`automatic title generation failed: …`) and keep the latest
title. The provider refuses rather than guesses: an answer that is `UNCHANGED`,
carries no text, is not a two-segment `类型｜主题` line, contains a tool call, or
arrives from an unbounded stream leaves the current title in place and never
appends a partial `MMDD｜` line.
