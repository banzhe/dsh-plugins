# session-topic-map — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Shape

A dual-sided Bundle. The Host half owns the Session read, the model call, the graph transition, and its storage; the Client half is one right-sidebar page tab (`kind: session-topic-map`) with a guide entry, a model picker, and an SVG of whatever graph the Host last stored.

The tab is session-scoped: the seat hands the body `sessionId`, and every read and analysis names that Session. Nothing is shared between two Sessions' maps.

## Host routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/session-topic-map/models` | `GET` | Every provider route and the models it advertises right now |
| `/api/session-topic-map/state?sessionId=` | `GET` | The Session's stored graph, or the empty graph |
| `/api/session-topic-map/analyze` | `POST` | Read the next message range, ask the confirmed model, store the graph |

## The confirmation gate

The panel never calls a model on mount or on a selection change, and it never resumes a paused loop without a new confirmation. `POST /analyze` requires `confirm: true` in the body and refuses with `not-confirmed` before it resolves a provider when the field is absent, so the decision is enforced at the call site rather than in component state. The chosen route is re-checked against `ctx.llm.listModels(provider)` — a request naming a model the provider no longer advertises is refused with `unknown-model` instead of failing inside the adapter.

## Realtime analysis

After the confirmation the panel keeps the map current on its own (`src/client/drain.ts`):

- A run that read at least one message is followed immediately by the next run, so a long backlog drains in consecutive batches instead of one batch per tick.
- A run that found nothing waits `DRAIN_INTERVAL_MS` (2 s) before looking again. That look is an ordinary `POST /analyze`; the Host answers it from the stored checkpoint without calling a model, because a range with no readable message never reaches the model call.
- The loop is sequential: one run is awaited before the next, so two analyses can never overlap.
- Pausing, switching Session, and unmounting all abort the loop's `AbortController`. After an abort neither callback fires again, and the start button returns — pressing it is a fresh confirmation.

A failed run is not retried behind the user's back. One failure ends the loop, the start control returns to its idle label, and the panel shows the failure in a `role="alert"` banner with the reason and a retry button; nothing claims the analysis is still running. The reasons are told apart, because a user can act on them differently:

| What happened | What the client reports |
| --- | --- |
| The request never answered (120 s for an analysis, 15 s for a metadata read) | `failure.timeout` |
| The request could not reach the Host at all | `failure.network` |
| The Host refused with a code of its own | the Host's message, or `failure.http` with the HTTP status |
| The answer body was not the documented payload | `failure.body` |

The retry button is the only way back in, and pressing it issues a new confirmed request, so the model gate still holds. The banner disappears on the next successful run; a cancelled run never shows one.

## Incremental analysis

`planAnalysis` starts at `checkpoint + 1` (the last analyzed event seq, `-1` before the first run), tracks turn boundaries because a `user/message` event carries no turn of its own, and stops at the twenty-fourth message, the 12 kB framed-input cap, or the last event it read. Whatever it stopped on becomes the new checkpoint, so nothing between the checkpoint and the end of the log is ever skipped: the next run reads exactly that remainder.

A run that fails, is refused, or returns an answer the parser cannot read never calls `applyAnalysis`, and the route stores nothing — the checkpoint stays where it was and the same messages are read again. Two empty-looking answers are told apart, because they mean different things:

- `{"topics":[]}` is a legal answer — the model judged that the range advances nothing — so the run succeeds and the checkpoint advances. Re-reading it would ask the same question forever.
- A non-empty topic list where nothing survives validation (a label that is not a usable string, or a seq outside the range this run read) is an unreadable answer: it is refused with `unreadable-answer` and the checkpoint stays put, so the range is read again.

A range that holds no readable message (tool traffic only) still advances the checkpoint, so it is not rescanned forever.

Turns are taken from the log rather than inferred: an `assistant/message` carries its own turn, so a log whose inherited portion has no `turn/start` still anchors each reply to the right turn; `user/message` keeps the last turn seen.

## The progress graph

`src/progress-graph.ts` is the whole domain model and holds no I/O. Its one transition, `applyAnalysis`, takes the batch that produced it:

- **One independent node per `(seq, topic)`.** A node is identified by `n-<seq>#<encodeURIComponent(topic)>` and carries a single normalized `topic`. A reply that advances multiple topics creates multiple independent topic nodes at the same `seq` and `turn`.
- **Progress is strictly per topic.** Each node links only to the latest earlier node of that same topic, forming an independent progression chain with `branch` edges.
- **Parents are derived, never accumulated.** Every transition recomputes the links from the nodes and their topics, so a replay of the same batch yields the same graph and no link can survive from a version of the answer that no longer holds.
- **Top-to-bottom lane grid layout (`src/client/graph-layout.ts`).** Distinct `seq` values map to ascending vertical rows (`y`), so multiple independent topic nodes from the same reply sit side by side on the same row; each topic occupies a fixed horizontal lane (`x`) in first-appearance order, and links follow same-topic `branch` edges downward.
- Sources are not stored: each node carries the message's `seq` and `turn` as its anchor.
- The module never mutates its input, and a batch whose range is already covered returns the graph unchanged.

## Storage

One `storageDomain` table (`session_topic_map` / `graphs`) keyed by Session id. The record carries `schemaVersion: 3` and a zod schema mirroring the v3 independent-topic graph; `invalidRecords: 'backup-and-skip'` is right for this data because a graph is derived from the Session log and can be re-derived, so one unreadable record must not fail the whole domain. The record is written only after the run's answer parsed, so storage never holds a graph the analysis did not produce.

Earlier records remain accepted by the record schema so opening the domain over existing media cannot fail:

- A version-2 record (per-`seq` nodes with `topics[]`) is pure-projected on read by `currentGraphOf` into the version-3 independent-topic graph without calling a model, and `needsGraphMigration` flags it to be re-persisted as version 3.
- A version-1 record (keyed by topic label with per-topic sources) is never read as a graph: `currentGraphOf` answers `null` for it, the Session starts from the empty graph, and the next successful analysis overwrites the record with version 3. The domain keeps its version stamp because the stored table layout did not change.

## DOM jump

The panel finds nothing through the chat renderer's internals; it reads the markers ui-chat already publishes on every rendered row and writes nothing back except one attribute of its own.

The only marker this Bundle reads is ui-chat's own `data-chat-turn`. The transcript's other keys embed a length prefix plus `turn:step` — their digits identify a step, not a message — so nothing here parses them.

Clicking a box focuses that node's own turn: `focusTurn` outlines the last rendered row carrying `data-chat-turn="<turn>"` and scrolls it into view, and the panel reports that it located the turn, never that it found the exact message. When no row carries that turn — older turns are paged out of the rendered transcript — no attribute is added and the panel says the turn is outside the current view. The outline is `data-session-topic-map-focus`, styled only by a `:global` rule in this Bundle's own stylesheet, and each click removes it from the previous row. `ui-chat` is untouched.

Because a stored turn could be wrong, reading a graph is also when it is re-anchored: when a record has not been verified yet, `GET /state` reads the Session log once, takes each node's turn from the message the node stands for (an `assistant/message` states its own turn, a `user/message` inherits the last `turn/start`), answers the corrected graph, and marks the record verified. That costs no model call and keeps the stored nodes; an unreadable log leaves the graph untouched.
- Topics are labels the model chose. Two runs with different models may name the same subject differently, and a rename is a new topic rather than a move.
- Realtime analysis polls the Host while idle instead of subscribing to Session events; the interval is a fixed 2 s and is not configurable.
## Verifying in a DSH source checkout

Everything below was run against the source checkout at `D:\personal\dsh\deepseek-harness` (version 0.2.2-rc.2, artifacts already built by `pnpm run build:artifacts`; `pnpm run dev:web` builds them too).

1. Build the plugin: `pnpm --filter @banzhe/dsh-session-topic-map build` in `D:\personal\dsh\dsh-plugins`.
2. Install it into the source web profile (one time):

   ```powershell
   Set-Location D:\personal\dsh\deepseek-harness
   pnpm dsh plugin --profile web add D:\personal\dsh\dsh-plugins\plugins\session-topic-map
   ```

   This writes a `link:` dependency plus `@banzhe/dsh-session-topic-map` into `dsh.profile.bundles` of `$DSH_HOME/profiles/web/package.json` and installs it there. It is already installed in this machine's default home.
3. Confirm the row composes: `pnpm dsh --profile web --dump-config` prints `- id: session-topic-map` under a `# == @banzhe/dsh-session-topic-map` bundle header.
4. Serve: `pnpm start:web` (needs the built artifact tree) or `pnpm run dev:web` (builds artifacts, keeps the three watchers alive, then serves). Either prints `dsh web: http://127.0.0.1:<port>/?token=…`; the token is consumed on the first load and sets the browser cookie. `--port 0` lets the OS pick, `--no-open` keeps the browser closed.
5. In the GUI: open the printed URL, pick a session, expand the right sidebar, press `+` and choose 主题图 / Topic map from the guide.
   - The model picker lists the Host's own providers; nothing is called before 开始分析 / Start analysis.
   - Afterwards boxes appear, the status line reports the read span, and the tab keeps itself current; 暂停 / Pause stops it and the next press needs a fresh confirmation.
   - Clicking a box outlines that box's turn in the transcript and says it located the turn.

Stable hooks for browser automation — all on this plugin's own DOM, so no chat-renderer selector is needed beside `data-chat-turn`:

| Selector | Meaning |
| --- | --- |
| `[data-session-topic-map]` | panel root; `data-running` is present while the loop runs |
| `[data-session-topic-map-provider]`, `[data-session-topic-map-model]` | the provider and model pickers |
| `[data-session-topic-map-control]` | start/pause button; `data-state` is `idle` or `running` |
| `[data-session-topic-map-error]`, `[data-session-topic-map-retry]` | failure banner and its retry control |
| `[data-session-topic-map-status]` | last run's span, or the stored checkpoint |
| `[data-session-topic-map-graph]` | the SVG |
| `[data-session-topic-map-node="n-<seq>#<topic>"]` | one independent topic node box (`topic` URI-encoded) |
| `[data-chat-turn="<turn>"][data-session-topic-map-focus]` | the outlined transcript row |

Calling the routes directly needs the same browser trust the UI has (origin header plus the boot cookie):

- `GET /api/session-topic-map/models`
- `GET /api/session-topic-map/state?sessionId=<session>`
- `POST /api/session-topic-map/analyze` with `{"sessionId","provider","model","confirm":true}`

For a smoke test that touches none of the user's data, copy `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.yml` and `cordis.patch.yml` from `$DSH_HOME/profiles/web` into `<temp-home>/profiles/web`, run `pnpm install` there, and boot with `$env:DSH_HOME=<temp-home>`. That instance proves installation and activation (the plugin's routes answer, its bundle is listed in the boot payload) but lists no models, because the temporary home has no credentials.

To remove the plugin again: `pnpm dsh plugin --profile web remove @banzhe/dsh-session-topic-map`, then drop its entry from `dsh.profile.bundles` if it remains.

## Known limits

- Analysis covers user and assistant text only. Tool calls, tool results, and thinking blocks are skipped, so a conversation that is mostly tool traffic produces few topics.
- Jumping is turn-level: the transcript exposes no per-message marker, so a node points at the turn's last rendered row and the panel says so.
- The transcript renders only a window of recent turns, so a node whose turn is outside it cannot be jumped to at all; the panel reports that instead of pretending.
- Topics are labels the model chose. Two runs with different models may name the same subject differently, and a rename is a new topic rather than a move.
- Realtime analysis polls the Host while idle instead of subscribing to Session events; the interval is a fixed 2 s and is not configurable.