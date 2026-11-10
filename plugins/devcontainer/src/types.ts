/**
 * Repository container vocabulary: the discovered specification every module in
 * this Bundle passes around, and the shared executor options each Loader row
 * resolves from its own config.
 * @module @banzhe/dsh-devcontainer/types
 */

/**
 * How the executor reaches the repository's Linux runtime.
 *
 * `sbx` is the Docker Sandbox CLI: a sandbox mounts the host workspace at the
 * same absolute path, so a repository needs no Dev Container declaration to run
 * in one. `devcontainer` / `docker` reach a container the Dev Container
 * specification describes.
 */
export type ContainerCli = 'auto' | 'devcontainer' | 'docker' | 'sbx'

/** One repository's resolved container configuration. */
export interface RepoContainerSpec {
  /** Absolute host path of the repository root that owns the configuration file. */
  hostWorkspaceRoot: string
  /**
   * Absolute POSIX path the same root is mounted at inside the runtime.
   *
   * For a Dev Container this is the specification's `workspaceFolder`, or the
   * `/workspaces/<repo>` default. For a Docker Sandbox it is the path the
   * sandbox has for that directory: the host root itself on a Linux or macOS
   * host, and the drive-letter spelling (`/f/personal/repo` for
   * `F:\personal\repo`) on a Windows one.
   */
  containerWorkspaceFolder: string
  /**
   * Absolute host path of the configuration file this specification came from.
   *
   * Empty when the specification was synthesized: a `(sbx)` preset needs no
   * declaration, so it falls back to the directory the session works in.
   */
  configPath: string
  /** Explicit container name or id from `container` / `containerName`, when declared. */
  container?: string
  /** Compose service the container belongs to (`service`), when declared. */
  composeService?: string
  /** User commands run as inside the container (`remoteUser`), when declared. */
  remoteUser?: string
  /** Extra container environment entries (`remoteEnv`), when declared. */
  remoteEnv?: Readonly<Record<string, string>>
  /** Explicit Docker Sandbox name (`sandbox` / `sandboxName`), when declared. */
  sandbox?: string
  /**
   * Image a `sbx create` this Bundle issues runs, from the row's `sbxTemplate`.
   *
   * Absent when the row configured none, which leaves the CLI's own shell
   * template in place. Only a sandbox specification a row built carries it: a
   * declaration has no say in the image, and a sandbox that already exists is
   * never recreated for it.
   */
  sbxTemplate?: string
  /** Shell the command runs under inside the container (default `/bin/bash`). */
  shell: string
  /** Execution driver (default `auto`). */
  cli: ContainerCli
  /** Whether a `devcontainer up` / `sbx create` may run before the first command (default true). */
  ensureUp: boolean
  /** Budget for one container probe or start call. */
  containerTimeoutMs: number
}

/** The options a Loader row contributes to discovery, before the file overrides them. */
export interface ContainerOptions {
  shell: string
  cli: ContainerCli
  ensureUp: boolean
  containerTimeoutMs: number
  /**
   * Refuse to run commands on the host when a workdir names no Dev Container
   * repository (default false). This is what a `(devContainer)` preset implies
   * on its own; the flag exists for a deployment that wants that guarantee for
   * every preset.
   */
  requireContainer: boolean
}
