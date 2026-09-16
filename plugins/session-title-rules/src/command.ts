/**
 * The `/title-refresh` human command: re-derive one Session's title on demand
 * from its whole conversation, instead of only at its first prompt.
 *
 * The command owns no title logic. `ctx.sessionTitle.refresh()` is the whole
 * mechanism: it supersedes in-flight generation, runs the registered provider
 * against the current message snapshot, and appends one `session/title` event
 * — which also makes it the documented unpin, so an explicit invocation
 * deliberately overrides a user-renamed title. Everything this module adds is
 * the admission grammar (argument-free), the result mapping, and registration.
 *
 * @module @banzhe/dsh-session-title-rules/command
 */

// The `commands` Context augmentation arrives with the type-only import below:
// importing any member of `@deepseek-ai/dsh-commands` loads its `declare module`
// blocks, and `.../brand` alone would not (it augments nothing).
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'

/** Slash spelling without the leading slash; also the slash-menu row name. */
export const TITLE_REFRESH_COMMAND_NAME = 'title-refresh'

/** Refusal for any argument, mirroring `/compact`'s argument-free contract. */
const USAGE = `Usage: /${TITLE_REFRESH_COMMAND_NAME} (no arguments)`

/** The live Session the invocation arrived on, taken from its receiving agent. */
type InvokedSession = CommandInvocation['agent']['session']

/**
 * The one title-service capability this command uses. Narrow on purpose: a
 * test supplies a stub without standing up the whole service.
 */
export interface TitleRefreshTarget {
  /**
   * Re-derive the title from the Session's current message snapshot.
   * @param session - exact live Session to refresh.
   * @param signal - cancellation owned by the dispatching UI request.
   * @returns the accepted snapshot, or `undefined` when no eligible text exists.
   */
  refresh(session: InvokedSession, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>
}

/**
 * Map one `/title-refresh` invocation onto a {@link CommandResult}.
 *
 * A failure is reported as an error rather than swallowed: the automatic
 * cadence logs a warning and keeps the standing title, but an explicit
 * invocation is a direct question, so the reason (`no logged request route`,
 * a declined `UNCHANGED` answer, an abort) is the useful answer. Nothing here
 * writes a title — that belongs to the service, which appends only a validated
 * result, so a failed refresh never overwrites an accepted title. The failure
 * text is `errorChain`'s, so the provider's chained abort/timeout causes stay
 * visible instead of collapsing to the outermost message.
 *
 * @param sessionTitle - the title service, or a stub exposing `refresh()`.
 * @param invocation - the admitted human invocation.
 * @returns the settled command outcome.
 */
export async function executeTitleRefresh(
  sessionTitle: TitleRefreshTarget,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  let snapshot: SessionTitleSnapshot | undefined
  try {
    snapshot = await sessionTitle.refresh(invocation.agent.session, invocation.signal)
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: invocation.signal.aborted
        ? 'Title refresh cancelled.'
        : `Could not regenerate the title: ${errorChain(error)}`,
    }
  }
  if (snapshot === undefined) {
    return { kind: 'error', text: 'No conversation text to derive a title from yet.' }
  }
  // No `sourceEventSeq`: the only consumer of that field pairs a command with a
  // compaction summary, and `session/title` has no conversation node.
  return { kind: 'success', text: `Regenerated title: ${snapshot.title}` }
}

/**
 * Register `/title-refresh` for every composed human-command adapter.
 *
 * The child activation keeps a Profile without a command registry loading this
 * Bundle normally: the provider still registers, only the command is absent.
 * This is also why the command stays inside this Bundle's single Plugin rather
 * than becoming a second one — the two only need to enable together, and a
 * child activation is how a DSH plugin declares an optional service (the same
 * shape `plan-mode` and `permission-presets` use).
 * @param ctx - context exposing the session-title service.
 */
export function registerTitleRefreshCommand(ctx: Context): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      // No `definitionId`: it exists so a first-party client can substitute
      // localized copy for its own built-in commands, and this command carries
      // no such client face. It is also absent from the published
      // `dsh-commands` types this Bundle compiles against.
      name: TITLE_REFRESH_COMMAND_NAME,
      description: 'Regenerate this session title from the conversation',
      // No `input` hint on purpose: an argument-free command must execute on a
      // bare pick/Enter. A hint would make the composer claim a trailing space
      // for arguments this command refuses.
      handler: invocation => executeTitleRefresh(ctx.sessionTitle, invocation),
    })
  })
}
