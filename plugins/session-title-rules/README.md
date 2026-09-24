# @banzhe/dsh-session-title-rules

Rules-based Session title provider for the `web` Profile, plus the
`/title-refresh` command. It generates `emoji 主题` from the conversation
instead of the built-in first-prompt provider's free-form title.

## Install

From this repo root, after `lib/` exists:

```sh
dsh plugin --profile web add ./plugins/session-title-rules
```

Rebuild `lib/` after source changes. Adding the Bundle to `dsh.profile.bundles`
requires a `dsh web` restart. Sessions created after the restart are titled by
this provider. A Session that already carries a title keeps it — nothing
re-titles it automatically — until you run `/title-refresh`.

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

- Format: `emoji 主题`, e.g. `🔬 会话标题插件接缝`.
- The emoji is the closed set ✨ 功能 / 🎨 设计 / 🐛 修复 / ⚡ 优化 / 🚀 发布 /
  🔍 探索 / 📝 文档 / 🔬 研究, and stands for the whole type segment.
- `主题` is distilled from the actual messages, never repeats the project name,
  and stays short enough for the sidebar (6–14 CJK characters, ≤ 8 English words).
- Topic language follows the conversation; mixed Chinese/English uses Chinese.
- Input tolerance is mapping-free: `⚡️ 主题` (presentation selector), `🐛主题`
  (no gap), and `🐛｜主题` (retired separator) all canonicalize to `emoji 主题`.
  An answer that leads with any other glyph — the retired `类型｜主题` words
  included — is refused rather than translated, because mapping a type word the
  model chose onto an emoji it did not choose is this provider inventing a type.
- When the messages do not identify a topic, the model answers `UNCHANGED`; the
  revision then fails, so the service warns and the current title stands instead
  of a guess.

Two of the requested rules need no prompt line: a user-renamed title
already pins the Session, so automatic generation stops scheduling, and a
provider can append nothing but `session/title` — project name, content,
membership, ordering, pinning, and archiving are structurally out of reach.

## `/title-refresh`

Re-derives the title on demand from the Session's whole conversation, so an old
Session can be retitled without opening a new one:

```
/title-refresh
```

It takes no arguments. The command itself holds no title logic — it calls
`ctx.sessionTitle.refresh(session, signal)`, which supersedes any in-flight
generation, runs this provider against the current message snapshot, and
appends one `session/title` event. Consequences worth knowing:

- **It overrides a user-pinned title.** `refresh()` is the service's documented
  unpin, so renaming in the sidebar and then running this command keeps the
  regenerated title. A later sidebar rename pins again.
- **No date prefix.** The title carries only `emoji 主题`; a model-authored
  `0903｜` date prefix is stripped before the title is accepted.
- **Failures are reported, not swallowed.** The automatic cadence only warns and
  keeps the standing title; an explicit invocation answers with the reason —
  `no logged request route` before the first model request, a declined
  `UNCHANGED`, a malformed answer, or cancellation. A failed refresh never
  overwrites an accepted title. On a Session that has messages but no title yet,
  the service still materializes its deterministic fallback first, exactly as the
  automatic path does.
- **An empty Session is an error**, because there is no eligible human text to
  derive a topic from.
- **A newer invocation wins.** Two overlapping refreshes settle newest-first;
  the superseded one reports the abort as an error.

The row appears in the commands menu under its English description. It carries
no `definitionId`, so the Web client shows the catalog text rather than a
localized first-party face, and no `input` hint, which is what lets a bare pick
execute immediately.

## Behaviour and cost

- `automatic: 'first-prompt'`: the title is derived once, from the Session's
  first eligible human message — one auxiliary model call (`maxTokens: 512`) and
  one *provider* `session/title` event per Session (the service appends its
  deterministic fallback first). Change `automatic` in `src/index.ts` to
  `'all-prompts'` to re-derive the topic on every user message instead —
  subagent Sessions would then be titled too, because `all-prompts` has no
  parent-session check.
- The recorded provenance is `source.provider = 'session-title-rules'` with the
  auxiliary route as `model`.
- Unlike the shipped providers this one appends no log-only
  `session/title-llm-request` audit row and never reuses
  `@deepseek-ai/dsh-session-title-llm` (whose system prompt is private), so the
  auxiliary request is not reconstructable from the log.
- Routing follows the Session's logged `request/header` route, unless the
  title-model page pins an explicit model (see below). Explicit
  `ctx.sessionTitle.refresh()` before any header exists has no route, so an
  *unconfigured* provider fails and the deterministic fallback stays — pinning a
  model is what makes that case work.
- Under this cadence, subagent and fork children are never titled:
  `first-prompt` schedules only for a top-level Session
  (`header.parentSession === undefined`), and a fork child inherits its parent's
  title through the seed.

## Choosing the title model

The row carries an optional `config`, so the model that writes titles is a
setting rather than a rebuild:

```yaml
- id: session-title-rules
  config:
    provider: cliproxyapi
    model: cc/deepseek-v4.1-flash
    reasoningEffort: off
```

All three fields are optional and all three are `volatile`, so a change reaches
the **next** title without restarting `dsh web`. Resolution order is:

1. an explicit `provider` + `model` pair, when configured;
2. otherwise the Session's logged `request/header` route (the original
   behaviour);
3. failing both, a refusal — never a guess.

**`provider` and `model` must be set together.** Half a pair is refused rather
than falling back, because a deployment that set only `provider` asked for
something the plugin cannot honour, and quietly titling with the session's model
would hide the mistake. The same refusal covers a `provider`/`model` the adapter
does not know: `ctx.llm.stream` rejects it with `UNKNOWN_MODEL` before any HTTP
request, the automatic path warns and keeps the standing title, and
`/title-refresh` reports the reason.

`reasoningEffort` is separate from the model choice and worth setting: it is the
only way to stop a reasoning-enabled route spending its whole 512-token budget
on hidden thinking before it writes a title (see *Why the output cap is 512*).
Omit it to follow the route's own default.

### The settings page

The model is chosen in the Web UI, not by hand-editing YAML: **Settings →
Plugins → this plugin's row → Configure** (the `plugins.row.config` slot, keyed
`@banzhe/dsh-session-title-rules#session-title-rules`).

- The model dropdown lists the **live adapter directory**
  (`remote.session.modelCatalog()`, the same source the composer's picker reads),
  grouped by provider, plus a *follow the session model* option. Only routes the
  LLM seam can actually resolve are offered, so pinning an uncallable id is not
  reachable from the UI.
- The effort dropdown offers only the levels the **chosen model** advertises. A
  level the model does not support fails the call with
  `UNSUPPORTED_REASONING_EFFORT`, so switching models clears an effort the new
  model cannot take. The list is **generated from configuration**, not fixed:
  it comes from each model's `reasoningEfforts` in the profile's `cordis.patch.yml`,
  resolved through `llm-pi-ai`'s `getSupportedThinkingLevels`. Editing the YAML
  changes the dropdown; only `xhigh` and `max` must be declared explicitly, since
  `off`/`low`/`medium`/`high` follow from a model being marked as reasoning.
- Each level shows the adapter's display **name** (`High`) while the page stores
  the wire **id** (`high`) — the same split the composer's own picker makes. A
  stored level that no model advertises any more is kept, labelled by its id, so
  a configured value is never invisible.
- A route saved earlier that has since left the directory stays listed (marked
  *saved but currently unavailable*) so it can still be seen and cleared;
  removing it instead would silently reset the choice on the next save.
- The page writes `unset` for "follow the session model" and "route default
  effort": an absent field is what the provider reads as unconfigured, whereas an
  empty string would be dispatched as a model id.

Configuring by YAML directly is still supported and equivalent; the page and the
file edit the same `session-title-rules` entry.

Both choices render as the shell's own settings dropdown — a pill trigger that
opens the shared `Menu` from `ui-primitives` — copying `PreferenceRow` in
`ui-chat/src/client/settings/`, the row shape the General settings use. It is
**not** a native `<select>`: a native select's popup is drawn by the operating
system, so it can never carry the theme, and the checkmarked card the reference
settings show is reachable only through `Menu`. `Menu` brings its own stylesheet,
so the card, its elevation, and its keyboard walk need nothing from this Bundle.

Only the row and its trigger are styled here, by an injected `--dsw-*` token sheet
(`src/client/styles.ts`). Inline styles would not do: inline declarations beat
every stylesheet, so a control carrying a `style` attribute falls back to browser
defaults instead of the shell's chrome. This Bundle builds its browser half
without a CSS pipeline, so the sheet is a plain string installed on the plugin's
fiber — the same approach as `app-notification`.

## Fixed policy

The row's `config` carries only the route above. The caps below stay in
`src/index.ts`: `maxOutputTokens: 512`, `timeoutMs: 60000`,
`maxInputBytes: 6000`, at most 8 messages (first + 7 most recent), 400
characters per message. Over-cap input drops the oldest messages; the accepted
title is finally normalized and truncated to `maxTitleBytes` by the service —
truncation is code-point-safe, so a byte cap can drop the type emoji (4 UTF-8
bytes) but never split it into a replacement glyph.
`/title-refresh` is argument-free: any trailing input is refused with a usage
error.

### Why the output cap is 512, not 64

The cap has to cover hidden reasoning, not just the title line. `GenerateOptions`
carries `purpose: 'session-title'` as the seam's "this is an auxiliary call"
hint, but only `@deepseek-ai/dsh-llm-deepseek` acts on it
(`serialize.ts`: `return { thinking: 'disabled' }`).
`@deepseek-ai/dsh-llm-pi-ai` never reads `purpose` at all — it takes the route's
own effort (`adapter.ts`: `options.reasoningEffort ?? profile.reasoning`), and
its `off` level merely *omits* the reasoning field, which a provider that thinks
by default ignores. On such a route a 64-token budget is spent entirely on
thinking: `finish=length` with 64 of 64 tokens in `reasoning_tokens`, no text,
so the provider throws and the deterministic fallback stands.

Measured on `cc/deepseek-v4.1-flash` with this plugin's exact prompt and framed
input, 20 trials each: 1/20 usable at 64 tokens, 17/20 at 512. The built-in
provider is not better — the same measurement with its 4-line prompt and
`dsh-base`'s `maxOutputTokens: 64` gives 2/20. Raising this constant is the only
lever inside this plugin; the durable fix belongs upstream in `dsh-llm-pi-ai`
(honour `purpose`) or in `dsh-base`'s default.

Failures warn (`automatic title generation failed: …`) and keep the latest
title. The provider refuses rather than guesses: an answer that is `UNCHANGED`,
carries no text, does not lead with one of the eight type emoji, names no topic,
contains a tool call, or arrives from an unbounded stream leaves the current
title in place and never appends a partial line.
