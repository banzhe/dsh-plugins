/** Remote launch command and POSIX shell quoting for the helper target this client starts. */
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Deployment-owned helper invocation; script deployments may also install a PTC bootstrap. */
export type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}

/** One remote launch command with the PTC bootstrap its deployment installed. */
interface TargetLaunch {
  /** Remote command line the SSH client passes as its single command argument. */
  command: string
  /** Absolute remote PTC bootstrap; published only when configured and paired with {@link bootstrapHash}. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of {@link bootstrapPath}; published only when configured. */
  bootstrapHash?: string
}

/**
 * Quote one path as a single `sh` word, preserving every character the remote shell would interpret.
 * @param value - an absolute path or one literal word for the remote shell.
 * @returns the quoted shell word.
 */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the remote command that starts the installed helper with its SIGUSR1 debugger activation disabled.
 * The remote helper runs on a POSIX host, so POSIX quoting applies to every configured path.
 * @param launch - the configured helper invocation.
 * @param helper - absolute remote helper entry.
 * @returns the command line and the PTC bootstrap fields the deployment installed.
 */
export function launchCommand(launch: HelperLaunch, helper: string): TargetLaunch {
  switch (launch.kind) {
    case 'node-script':
      return {
        command: [launch.node, '--disable-sigusr1', helper].map(shellWord).join(' '),
        ...(launch.bootstrapPath === undefined ? {} : { bootstrapPath: launch.bootstrapPath }),
        ...(launch.bootstrapHash === undefined ? {} : { bootstrapHash: launch.bootstrapHash }),
      }
    case 'executable':
      return { command: `NODE_OPTIONS='--disable-sigusr1' ${shellWord(helper)}` }
    /* v8 ignore next -- Config parsing admits only these two launch kinds. */
    default: return assertNever(launch)
  }
}
