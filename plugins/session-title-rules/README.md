# @banzhe/dsh-session-title-rules

A rules-based Session title provider: it generates `emoji 主题` from the conversation instead of the built-in first-prompt provider's free-form title.

[中文版](./README.zh-CN.md)

A dual-sided [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web** profile.

## Features

- Replaces the built-in first-prompt title provider. The title service holds exactly one provider slot, so the built-in row is disabled while this Bundle is installed; removing the Bundle restores it.
- Format: `emoji 主题`, e.g. `🔬 会话标题插件接缝`.
- The emoji is a closed set — ✨ 功能 / 🎨 设计 / 🐛 修复 / ⚡ 优化 / 🚀 发布 / 🔍 探索 / 📝 文档 / 🔬 研究 — and stands for the whole type segment.
- `主题` is distilled from the actual messages, never repeats the project name, and stays short enough for the sidebar (6–14 CJK characters, ≤ 8 English words).
- Topic language follows the conversation; mixed Chinese/English uses Chinese.
- Input tolerance is mapping-free: `⚡️ 主题`, `🐛主题`, and `🐛｜主题` all canonicalize to `emoji 主题`. An answer that leads with any other glyph is refused rather than translated.
- When the messages do not identify a topic, the model answers `UNCHANGED`; the service warns and the current title stands instead of a guess.
- `/title-refresh` re-derives the title on demand from the Session's whole conversation, so an old Session can be retitled without opening a new one. It takes no arguments.
- The title model is a setting, not a rebuild: **Settings → Plugins → this plugin's row → Configure** (or the same `config` in YAML) pins a `provider` + `model`, optionally with a `reasoningEffort`. All three fields are optional and reach the **next** title without restarting `dsh web`.
- `provider` and `model` must be set together; half a pair is refused rather than silently falling back to the session's model. With neither set, routing follows the Session's own logged route.
- Subagent and fork children are never titled under the default cadence: `first-prompt` schedules only for a top-level Session, and a fork child inherits its parent's title.
- The settings dropdowns list the live adapter directory and only the reasoning levels the chosen model advertises, so pinning an uncallable route is not reachable from the UI.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-title-rules
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-title-rules build
dsh plugin --profile web add ./plugins/session-title-rules
```

Adding the Bundle to `dsh.profile.bundles` requires a `dsh web` restart. Sessions created after the restart are titled by this provider. A Session that already carries a title keeps it — nothing re-titles it automatically — until you run `/title-refresh`. Rebuild `lib/` after later source changes.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-session-title-rules
```

## Docs

Implementation notes: [`docs/plugins/session-title-rules.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-title-rules.md).
