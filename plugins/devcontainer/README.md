# @banzhe/dsh-devcontainer

Runs every agent command inside the repository's Linux Dev Container — or a Docker Sandbox — and makes the model believe it is already there: `bash`, Linux paths, Linux commands. Any repository that declares a Dev Container gets container execution; every other directory keeps the ordinary local shell, unchanged.

[中文版](./README.zh-CN.md)

A Host-only [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle for the **web**, **desktop**, and **CLI** profiles.

## Features

- **Repository discovery.** The executor walks up from whatever directory a command names and takes the nearest declaration: `.dsh/devcontainer.json` or `.dsh/docker.json` first, then `.devcontainer/devcontainer.json`, then `.devcontainer.json`. All three accept JSONC (comments and trailing commas).
- **Real container execution.** Commands run through `docker exec -i -w <container workdir>`, from an explicit `container`/`containerName`, from the running container the Dev Container CLI labelled `devcontainer.local_folder=<repo>`, or from `devcontainer up` when nothing is running yet.
- **Linux paths in, Linux paths out.** `ctx.shell` reports the container workdir (`/workspaces/<repo>/src`), while the process itself starts in the host repository root — `child_process` cannot enter a Linux path on Windows.
- **The Session directory is a host path.** `WorkingDirectoryService` records whatever `ctx.fs.processPath` answers, and a container path is not a host path on Windows: `/f/personal/repo` made the `.git` probe resolve `F:\f\personal\repo\.git`, which is inside no repository, and the refusal killed a delegating `… (sbx)` subagent before its first step. For a Windows-rooted repository `processPath` therefore answers the host path of a container target; the container spelling keeps its two uses, the argv a runtime is started with (`cd -- /f/personal/repo`) and the payload of an RPC request.
- **Host processes start where the host can enter.** A `(devContainer)` session hands every seam container paths, but a child process cannot start in one: the `run_code` PTC worker died with `spawn … ENOENT` before its first `tools.read` call. `ctx.subprocess.spawn` is decorated so a working directory that belongs to a discovered repository is translated back onto that repository's host root — POSIX path arithmetic plus the root's own separator style, so a Windows, Linux, and macOS host take the same code path — while an ordinary session, a host path, and a container path no declaration owns reach the provider exactly as written. Only the directory moves: what the worker then does with files is still `ctx.fs`, still the container RPC pipe. `ctx.ptcRuntime` is decorated for the same reason at its own two entry points: `resolve` fills a directory the caller left out from the sandbox policy's workspace root — the container's `/workspaces/<repo>` — and `run` hands that directory to the worker that `chdir`s into it, so both translate a container path onto the host repository root, and a request or spec that names anything else reaches the provider untouched.
- **Files run in the container too.** A `(devContainer)` session's `ctx.fs` delegates every operation — `resolve`, `stat`, `lstat`, reads, listings, byte ranges, `write`, `edit`, `patch`, `delete`, and `move` — over a persistent stdio RPC pipe to a Node helper running inside the container (DSH's SSH helper framing, protocol 3). The container resolves the path, follows the symbolic link, and performs the I/O, so no host path is opened, and `read`, `write`, `edit`, `glob`, `grep`, and `working_directory` all keep working with Linux spellings. Ordinary presets keep the earlier behaviour: the container view (`/workspaces/<repo>/…`, and the `F:\workspaces\<repo>\…` a Windows model mangles it into) is mapped onto the host bind mount, with the sandbox write fence inherited unchanged.
- **A Linux prompt.** The `working-directory:current` context becomes `Current working directory: "/workspaces/<repo>"` plus a `Runtime environment: Linux Docker container … always write POSIX/Linux commands and never PowerShell commands` line.
- **No environment bleed.** Only `remoteEnv`, the caller's own entries, the `DSH_*` snapshot, and `TERM=dumb`/`GIT_TERMINAL_PROMPT=0`/`NO_COLOR=1` reach the container: no host `PATH`, no `SystemRoot`. The Docker / Dev Container CLI itself starts from a scrubbed environment too — an allowlist of what it needs to find `docker` and read your Docker configuration, plus the `DOCKER_*`/`XDG_*` families, with credential-shaped names dropped — so the harness's own credentials never reach it or the processes it starts.
- **A settings page that derives presets on demand.** On Windows the shipped presets mount `pwsh` and disable `bash`; a Dev Container is Linux, so checking a preset on the **Settings → Dev Container presets** page derives a `… (devContainer)` copy of it (for example `委派模式 (devContainer)`, `标准模式 (devContainer)`) that mounts `bash` and sends its subagents to their own derived copies. Subagent routes are followed four levels deep; a route that limit stops is dropped (an allowed choice removed, a fixed preset row disabled) instead of being left pointing at the ordinary preset. The page carries two independent groups: **Dev Container** (the `sources` list, heading `(devContainer)`) and **Docker Sandbox** (the `sbxSources` list, heading `(sbx)`), and checking a box in one group never touches the other list. Nothing is derived until you check something, unchecking disposes the copy immediately, and the presets you already have are never modified — a preset that mounts no shell tool (the delegate main agent) derives to one that still mounts none.
- **Docker Sandbox (`sbx`) is a second track, with no declaration required.** A `… (sbx)` preset derives from the new `sbxSources` list the same way `… (devContainer)` derives from `sources` — same shell-tool flip, same depth-bounded subagent routing, but each track routes only into its own variants. Because a sandbox is given a host directory to mount rather than a build to describe, a repository needs no `.devcontainer/devcontainer.json`: the sandbox `dsh-<repo>-<hash>` is listed (`sbx ls --json`), created (`sbx create --name … shell <root>`) and started detached (`sbx run --detach --name …`) on first use, and commands run as `sbx exec <name> -- /bin/sh -c "cd -- '<workdir>' && exec … '<shell>' -c '<command>'"`. `ctx.fs` delegates to the same container helper over `sbx exec -i <name> -- node …`, so reads and writes happen inside the sandbox, and a missing `sbx` CLI is reported as an install problem rather than as a missing sandbox. A filesystem call names its workspace the way the sandbox mounts it (`/f/personal/repo`), which is no host path at all, while one row serves every session on the host and its configured `cwd` is the directory DSH started in: the host directory is recovered from the mounts `sbx ls` reported — the deepest one wins and names the workspace, declaration or not — and from the drive convention only when a repository really declares a container there, so a path outside every mount is still refused on the host. The shell row reverses the same spelling before it looks a repository up, so a workdir of `/f/personal/repo` runs in that directory's sandbox even when the row was mounted without a `cwd`.
- **Falls back to the platform's own shell** for ordinary presets: a directory with no Dev Container declaration keeps the local provider it had before — bash on POSIX, PowerShell on Windows (`pwsh -NoLogo -NoProfile -NonInteractive -Command`) — so the ordinary `pwsh` tool keeps working outside container repositories.
- **Container routing follows the preset.** A `… (devContainer)` preset runs every command in the repository's container; an ordinary preset keeps the host shell it had, even in a repository that declares a container. Set `requireContainer: true` on the rows to make every session container-bound instead.
- **A `(devContainer)` preset never runs on the host by accident.** The shell tools mark every call issued from a derived preset, so a repository that declares no container gets a warning in the working-directory context (the model is told to say so, in Chinese, and to stop retrying) and the executor **refuses** the command with `exitCode: 1` and a diagnostic instead of falling back. Ordinary presets are unaffected.
- **Files are refused with the commands.** `ctx.fs` reads the same preset for the agent that issued the call (a subagent answers for its own Session), so in a repository that declares no container every `resolve`, `read`, `write`, `edit`, `stat`, and listing is refused with a structured `FS_PERMISSION_DENIED` — no host file is read, written, or created. A `(devContainer)` session over a repository that DOES declare a container is fully delegated to that container, and an ordinary preset keeps the plain host filesystem. Looking like it is inside the repository is not enough: a symbolic link that resolves outside the repository's mount is refused the same way, and the diagnostic names the link target.

A repository opts in with any one of the three shapes, for example:

```jsonc
// .devcontainer/devcontainer.json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "workspaceFolder": "/workspaces/my-repo",
  "remoteUser": "vscode",
  "remoteEnv": { "CI": "1" },
}
```

```jsonc
// .dsh/docker.json — the lightweight form: reuse a container that is already running
{
  "container": "my-repo-dev",
  "workspaceFolder": "/workspaces/my-repo",
}
```

Every field, the driver fallbacks, and the preset mechanics are documented in the implementation notes.

## Install

### From npm

```sh
dsh plugin --profile web add @banzhe/dsh-devcontainer
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-devcontainer build
dsh plugin --profile web add ./plugins/devcontainer
```

Restart `dsh web` (or the CLI session) afterwards: the Bundle replaces `ctx.shell` and `ctx.fs` at activation, and the preset variants are registered from the Loader tree once it settles. Do not assume HMR.

The **`desktop` profile is off limits to the CLI**: add this Bundle through the application's own plugin manager, or add the dependency and the `dsh.profile.bundles` entry to `$DSH_HOME/profiles/desktop/package.json` by hand and run `pnpm install` in that directory. Profiles do not share a bundle list.

Remove with:

```sh
dsh plugin --profile web remove @banzhe/dsh-devcontainer
```

## Docs

Implementation notes: [`docs/plugins/devcontainer.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/devcontainer.md).

## License

MIT
