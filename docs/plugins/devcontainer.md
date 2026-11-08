# devcontainer — implementation notes

The plugin's README covers what it contributes and how to install it. This document records how it works, which DSH interfaces it attaches to, and what it deliberately does not do.

Three version facts the references below depend on:

- the peers say `^0.2.1-alpha.2` and the catalog resolves that exact version, so the build typecheck sees **0.2.1-alpha.2** typings;
- the source tree read for behaviour references is the `F:\personal\dsh\deepseek-harness` checkout, which is **newer** than the alpha (its `system-prompt` exports `PromptPresentation`; the alpha exports `PromptAssembly`). Where the two disagree the installed typings decide, because those are what the Bundle compiles against;
- DSH evaluates peer ranges with `{ includePrerelease: true }`, so the running rc satisfies `^0.2.1-alpha.2`.

## The Bundle is three Loader rows

| row | entry | role |
| --- | --- | --- |
| `devcontainer` | `src/index.ts` | the Linux prompt context, the `ctx.subprocess.spawn` and `ctx.ptcRuntime` working directories, and the `… (devContainer)` preset variants |
| `devcontainer-shell` | `src/shell.ts` | provides `ctx.shell` |
| `devcontainer-fs` | `src/fs.ts` | provides `ctx.fs` |

Row shapes are part of the contract. The Loader normalizes a module through `unwrapExports` (`vendor/loader/src/index.ts:209-216`), which prefers a `default` export, so:

- `src/index.ts` exports `name`, `Config`, and `apply` and **no** `default`. A `default`-exported `apply` would become the whole plugin, the module's `Config` would never reach Cordis, the row would activate with the raw (absent) config, and the first read of `config.presets` would throw at boot;
- `src/shell.ts` and `src/fs.ts` are class plugins by design, so their schema is a **static** (`static override Config`). A module-level `Config` next to a `default` class never reaches the class, and the row would run on the inherited schema with every container knob silently dropped.

They are separate plugins because each provides one service — Cordis owns one implementation per service name per scope — and they ship in one Bundle because they must enable as one layer: a container shell whose filesystem still speaks host paths would hand the model Linux paths nothing can open. All three rows share one discovery cache (`src/registry.ts`), because “this repository's container” must mean the same thing to all of them.

The package also ships a **browser entry** (`.` -> `lib/index.js`, `./shell`, `./fs`, `./client`) declared as `dsh.client` in `package.json`: the Dev Container presets page. The client module scanner picks it up from the same package, so `cordis.patch.yml` needs no second row for it.

`cordis.patch.yml` disables the four rows that would otherwise win a service slot or offer a Windows-only shell:

- `bash-sandbox` and `pwsh-sandbox` provide `ctx.shell` (`packages/bundle/base/cordis.patch.yml:249-257`); the container executor subclasses `SandboxBashExecutor` (see [the executor](#ctxshell-the-container-executor)), so the argv, the cwd, and the host-side confinement are all inherited;
- `fs-sandbox` provides `ctx.fs` (`:524-525`); the row subclasses the same `SandboxedFileSystem`, so an ordinary preset keeps the inherited per-call write fence, while a container-bound session delegates to the container instead (see [the container filesystem](#ctxfs-the-container-filesystem)).

The patch says nothing about `tool-bash` or `tool-pwsh`, and that omission is deliberate. `packages/bundle/web-app/cordis.patch.yml:493-497` disables both at the host level because which shell tool an agent gets is a PRESET decision, not a deployment one: the delegate main agent mounts no shell tool at all, while `standard` and the subagent presets mount the platform pair. A host-level `tool-bash: disabled: false` from this Bundle would override that (patch layers apply after the surface overlay) and hand `bash` to every agent, including the ones whose preset deliberately has none. The bash/pwsh flip lives in the derived presets instead.

Rollback is removing the Bundle from the Profile: the disabled rows re-enable themselves and each replaced service returns to its local provider.

## Repository discovery

`src/config-loader.ts` probes, in each ancestor directory and in this order:

1. `.dsh/devcontainer.json`, `.dsh/docker.json` — this Bundle's lightweight form;
2. `.devcontainer/devcontainer.json` — the Dev Container specification;
3. `.devcontainer.json` — the single-file variant.

The walk starts at whatever path a tool call names, so a file path works as well as a directory: probing `<file>/.devcontainer/…` simply misses and the next ancestor is tried. The nearest declaration wins; the directory holding it is the repository root (`hostWorkspaceRoot`).

Parsing is JSONC because `devcontainer.json` allows comments and trailing commas and no shipped parser accepts them. `src/jsonc.ts` strips both with a string-aware scanner, so a URL with `//` or a shell fragment with `/* … */` inside a value survives.

The discovered `RepoContainerSpec` is cached twice: per directory (the ancestor walk, including misses) and per option signature (the parsed specification). A container path has no host ancestry to walk, so it is matched against the specifications already discovered — or against the caller's `cwd`, whose ancestry does reach the repository. That is why the first lookup for a container path must come with a host `cwd`; every real call site has one.

### Configuration reference

| field | aliases | meaning | default |
| --- | --- | --- | --- |
| `workspaceFolder` | — | POSIX path the repository is mounted at in the container | `/workspaces/<basename of the repository root>` |
| `container` | `containerName` | an existing container name or id: `docker exec` against it, no probing | none |
| `service` | — | compose service the container belongs to | none |
| `remoteUser` | — | user commands run as (`docker exec -u`, `devcontainer exec --remote-user`) | image default |
| `remoteEnv` | — | extra container environment, injected as `-e KEY=VALUE` | none |
| `shell` | — | shell the command runs under inside the container | `/bin/bash` |
| `cli` | — | `auto` / `devcontainer` / `docker` | `auto` |
| `ensureUp` | — | may `devcontainer up` run before the first command | `true` |
| `requireContainer` | all three rows | make **every** execution container-bound: refuse on the host when the workdir names no container repository, and rewrite the prompt for it | `false` (a derived preset implies it) |

Each row's own config carries the same four executable fields (`shell`, `cli`, `ensureUp`, `containerTimeoutMs`) as deployment defaults; the file overrides them per repository. `workspaceFolder` must be an absolute POSIX path — a Windows-shaped value would name a directory the container cannot enter, so it is rejected with the offending file in the message.

## Two-way path translation

`src/paths.ts` is pure and idempotent. The rule is “attribute it or leave it alone”:

- **host → container** (`toContainerPath`): a container path stays as it is; a drive-mangled `F:\workspaces\<repo>\…` is recovered first; a host path under `hostWorkspaceRoot` becomes `posix.join(containerWorkspaceFolder, relative)`; a relative path joins the mount point; any other absolute path — a POSIX path this mount does not hold included — comes back slash-normalized, so the containment check refuses it instead of re-basing it onto the mount under a name no caller wrote.
- **container → host** (`toHostPath`): a path under the mount point becomes `win32.join(hostWorkspaceRoot, remainder)`; a relative path, a host path, and a foreign container path come back untouched.

Windows comparisons fold case and separator style (`F:\a\B` and `f:/a/b` are one directory); POSIX comparisons stay case-sensitive, because Linux paths are. Mixed separators need no special case: `path.win32` already accepts `/`, which is why `tool-bash`'s `${sessionCwd}${sep}${modelWorkdir}` output (`F:\repo\src/utils`) maps correctly.

## `ctx.shell`: the container executor

`src/shell.ts` extends `SandboxBashExecutor`, so deadlines, output caps, spill files, job handles, background semantics, the per-call sandbox policy, and the host-side confinement are unchanged; only the execution boundary of a container-bound command moves.

Extending the sandboxed base rather than the plain one is not a detail. `ctx.shell.sandboxMode` is the capability fact `@deepseek-ai/dsh-permission-presets` reads when it composes, and an executor that cannot report one makes that row refuse to activate ("the mounted bash executor does not confine") — the permission presets would silently disappear from every session in the Profile. A container-bound command therefore reports what it is: it runs unconfined *on the host*, because the container is what confines it, and its settled result carries `sandbox: { mode: 'danger-full-access', denied: false }`. Every other command keeps the platform's confinement — bash through the inherited path, PowerShell through the same `ctx.sandbox.confine` wrap `@deepseek-ai/dsh-pwsh-sandbox` used.

`resolve()` calls the inherited implementation, then — when the resolved workdir belongs to a repository with a container — rewrites `spec.workdir` to its container POSIX path. That single field is what `tool-bash` reports back as `cwd`, so the model immediately sees `/workspaces/<repo>/src` and keeps writing container paths.

`execute()` looks the repository up again from `spec.workdir` (now a container path, matched through the shared cache) and then:

1. builds a `hostSpec` whose `workdir` is `hostWorkspaceRoot` — `child_process` cannot chdir into `/workspaces/…` on Windows, which would surface as `ENOENT`;
2. hands it to the inherited `executeArgv(hostSpec, prepare)`, so the process mechanics, the deadline, and the cancellation all stay in the local executor;
3. assembles the real argv in `prepare` (`src/argv.ts`), after the container target is known.

The target comes from `src/container.ts`:

- an explicit `container`/`containerName` wins with no probe at all;
- otherwise `docker ps --filter label=devcontainer.local_folder --format …` finds the container the Dev Container CLI started, comparing the label to the repository root with separators and case folded;
- if none is running and `ensureUp` allows it, `devcontainer up --workspace-folder <root>` builds it and its last JSON line supplies `containerId`;
- when the id is still unknown, commands run through `devcontainer exec` instead.

A resolution is cached per repository (and per driver) so a burst of commands probes Docker once; a failed probe is evicted so the next command retries.

A `(sbx)` workdir is attributed before that lookup. A sandbox spells a Windows drive directory without the drive colon — `/f/personal/repo` for `F:\personal\repo` — and that spelling has no host ancestry to walk, so `locate()` reverses it through `sandboxHostPathFor` (`src/sbx.ts`) before asking the registry, on a Windows host only. Which directory the sandbox mounts then comes from the declaration the reversed path names, else the row's configured `cwd` (the workspace the sandbox was created around), else the workspace root a reported mount names, else the drive directory itself — so a row mounted without a `cwd` reaches `sbx exec` instead of refusing.

### The argv

```text
docker exec -i -w <containerWorkdir> [-u <remoteUser>] [-e K=V]… <containerId> <shell> -c <command>
```

```text
devcontainer exec --workspace-folder <root> [--remote-user U] [--remote-env K=V]… -- /bin/sh -c 'cd -- <containerWorkdir> && exec <shell> -c <command>'
```

The CLI form needs the shell wrapper because `devcontainer exec` starts its own process: a subdirectory workdir has to be entered inside the container. Both forms single-quote the inner words, so a command containing `'` survives.

Environment is the security-relevant half. The host process keeps the ambient environment it needs to find `docker` at all, but nothing from it is *forwarded*: the `-e` list is built from BASE_CONTAINER_ENV (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`), then `remoteEnv`, then the caller's `spec.env`, then the `DSH_*` snapshot — later sources win, and the keys are sorted so one command always yields one argv. A Linux `bash` reading a Windows `PATH` would find no binaries, and `SystemRoot` would be meaningless.

The host side of the same call is scrubbed as well. `execFile` receives `containerCliEnv()` (`src/exec.ts`) instead of the inherited environment: an allowlist of what a Docker / Dev Container CLI needs to start at all — executable lookup and the platform runtime, the per-user Docker configuration under `HOME`/`APPDATA` (where the credential helper is named), scratch space, locale, proxy routing — widened only by the `DOCKER_*` and `XDG_*` families the CLIs own, and narrowed by `SENSITIVE_ENV_PATTERN`, the credential-name heuristic every in-repo spawner shares. Passing nothing would hand the CLI the harness's own credentials and every unrelated host variable, and the processes it starts (`devcontainer up`'s build steps, a credential helper) inherit what it was started with.

### Which executions are routed

A repository that declares a container does not make every session run in it. The executor asks `requiresContainer()` first — the `DSH_DEVCONTAINER` marker in `spec.dshEnv` (set per call from the calling agent's preset, see [the guard](#the-devcontainer-guard)), or `requireContainer: true` — and only a container-bound execution is routed:

| session | repository declares a container | routed to |
| --- | --- | --- |
| a `… (devContainer)` preset | yes | `docker exec` / `devcontainer exec` |
| a `… (devContainer)` preset | no | refused (`exitCode: 1`, nothing runs on the host) |
| an ordinary preset | yes | the host shell — unchanged |
| an ordinary preset | no | the host shell |

That is also true of `resolve()`: an ordinary session keeps a host workdir even inside a container repository, because its own commands never leave the host and reporting `/workspaces/…` for them would name a directory this session cannot read. A deployment that wants the old behaviour — every command in the container — sets `requireContainer: true` on the rows, which makes every execution container-bound.

### Outside a Dev Container

Replacing `ctx.shell` means this row also serves every workdir that belongs to no Dev Container repository, and there the platform's own provider has to be reproduced: on POSIX that is the inherited bash executor, on **Windows it is PowerShell**. Reproducing it is not cosmetic. On Windows the shipped presets mount `tool-pwsh`, whose commands are PowerShell source; handing them to a Windows `bash` (often absent, and otherwise a different language) would turn working sessions into `command not found`. The fallback builds the same invocation `@deepseek-ai/dsh-pwsh-local` uses:

```text
<pwsh> -NoLogo -NoProfile -NonInteractive -Command "<UTF-8 preamble><command>"
```

`pwsh` is resolved by that package's own `resolvePwshPath` (explicit `pwshPath` config, PowerShell 7 install, PATH entries, then Windows PowerShell 5.1), and the UTF-8 preamble is its exported `ENCODING_PREAMBLE`. Deadlines, output caps, spill files, and cancellation stay the inherited ones.

Two knobs control it:

| field | default | meaning |
| --- | --- | --- |
| `localShell` | `auto` | `auto` = PowerShell on Windows, bash elsewhere; `bash`/`powershell` force one |
| `pwshPath` | empty (probe) | explicit PowerShell executable for the fallback |

`localShell: 'bash'` is the coherent pairing for a Windows host that wants the inherited bash executor outside containers too.

There is a single `ctx.shell` slot, so the slot cannot be bash for one agent and PowerShell for another — but it does not have to guess: the per-call marker says which kind of session is asking, and a container-bound session in a repository without a declaration is refused rather than handed the local shell (see the guard below).

## `ctx.fs`: the container filesystem

`src/fs.ts` extends `SandboxedFileSystem`, and a container-bound session does not use the inherited host I/O at all. Every entry point — `resolve`, `lstat`, `stat`, `readText`, `streamText`, `readBytes`, `readByteRange`, `listDir`, `watch`, `writeText`, `editText`, and the target-taking mutations this DSH build does not declare (`patchText`, `deleteFile`, `moveFile`) — is delegated over a persistent RPC pipe to a Node program inside the Linux container. The container resolves the path, follows the symbolic link, decodes the text, and performs the write; the host opens no file. A Windows drive letter is therefore not refused but unreachable: no host path exists in the exchange to begin with.

### The container helper

`src/helper/main.mjs` is the program on the other end. It is deliberately plain JavaScript with no dependency beyond `node:` builtins, because it runs on whatever Node the image ships, and it exports `handle(method, params)` while serving stdio only when it is executed directly — which is what lets the suite drive the shipped program with no process in between. `src/helper-source.ts` reads it from disk (`src/helper/main.mjs` from source, `lib/helper/main.mjs` in the built package, where tsdown copies it verbatim), and the row stages it into `/tmp/.dsh-devcontainer/helper.mjs` with one `docker exec -i … sh -c 'cat > …'` before opening the channel.

The wire format is DSH's own: a four-byte big-endian length header followed by one UTF-8 JSON document (`packages/ssh/ssh/src/protocol.ts`, `SSH_PROTOCOL_VERSION = 3`), with `request`, `result`, `error`, and `cancel` frames and a `hello` handshake that pins the protocol version and fixes the workspace. Every failure it reports carries a DSH filesystem code — `ENOENT` becomes `FS_NOT_FOUND`, `EACCES` becomes `FS_PERMISSION_DENIED`, `EISDIR` becomes `FS_NOT_REGULAR_FILE`, and so on — so the host maps one vocabulary onto the other instead of parsing messages.

Writes stage an owner-only file and publish it with `rename`, edits normalize line endings and restore the style on write-back, patches apply with the same NormalizeToLf matching rules as `@deepseek-ai/dsh-fs-patch`, and every mutation is serialized per path inside the helper, so read, guard, and write stay one critical section on the other side of the pipe.

### The RPC channel

`src/rpc/frames.ts` owns the codec, `src/rpc/client.ts` the channel, `src/rpc/pool.ts` the reuse, and `src/rpc/errors.ts` the translation back into `FsError`. One `docker exec -i <container> node /tmp/.dsh-devcontainer/helper.mjs` process serves the whole session: requests are correlated by UUID, each carries the row's `rpcTimeoutMs` budget and the caller's `AbortSignal` (a cancellation sends a `cancel` frame and rejects, and does not roll back a mutation the container already committed), and a pipe that dies fails every pending call with the helper's last stderr lines plus an explicit statement that the outcome of an in-flight request is unknown. Nothing is replayed.

Recovery belongs to the pool: a failed channel is dropped, and the next call stages the helper again, handshakes, and re-probes the container id. That is what makes a restarted or recreated container recoverable without restarting the session.

### What the row still decides

Containment stays on the host side, because the container is a larger world than the repository. A request is translated into the mount (`/workspaces/…`, or the drive-mangled `C:\workspaces\…` a Windows model produces) before it is sent, and both the requested path and the identity the container resolved must stay inside the repository's mount, or the call is refused with `FS_PERMISSION_DENIED` carrying `fsEscapeRefusalText`. A mount has more than one spelling on the host side of that check: the folder the specification carries, the realpath the container reported for it (a Dev Container feature may move the mount), and — for a sandbox — the drive-letter spelling the host convention gives the workspace, which is what a `(sbx)` session names even when no listing has reported the mount yet. A symbolic link inside the repository that points outside it fails at the container's resolution instead of at a host realpath, and the diagnostic names the link, both spellings, and the preset. A host path outside every declared container is refused before any round-trip.

`sandboxMode` is inherited unchanged and still reports the deployment's default. The per-call `sandboxPolicy` argument is ignored for a container target, because it describes host paths and a host mode while the container is the confinement; applying it would refuse writes the container owns.

`processPath` is the one identity that cannot stay inside the container. Host-bound consumers read it as a HOST path — `WorkingDirectoryService` commits it as the Session directory (`packages/session/working-directory/src/index.ts:176-184`), the project-root walk appends `.git` to that directory, and `ctx.subprocess` starts a process in it — so it answers the host path of a container target whenever the repository's workspace is a Windows path, and the inherited target key for every other repository. The distinction is the namespace, not the platform: on a POSIX host `/workspaces/<repo>` is a path the host's own path module resolves, and the `.git` probe reaches the repository's own directory through the container, while a Windows host has no root for `/f/personal/repo` — `path.resolve('/f/personal/repo', '.git')` yields `F:\f\personal\repo\.git`, a directory no repository contains. A Session directory recorded in the container spelling therefore escaped its repository: the project walk's probe left the mount and the filesystem refused it with `FS_PERMISSION_DENIED`, which killed a delegating subagent before its first turn. The container spelling keeps the two jobs it owns — the argv a runtime is started with (`buildExecArgv`) and the payload of an RPC request (`wireTargetOf`).

### Ordinary presets keep the host backend

Without the `(devContainer)` requirement — an ordinary preset, in any repository — every call keeps the host backend and the translation this row always did: `resolve` and `lstat` map `/workspaces/…` (and the drive-mangled spellings) onto the bind mount before delegating, and the inherited sandbox fence applies unchanged. A caller may pass a container path as `opts.cwd`; when the path alone names no repository, the row's configured `cwd` is the second chance at naming it.

### The filesystem refuses too

A `(devContainer)` preset that maps nothing is worse for files than for commands. A misdirected command fails loudly; a misdirected write silently changes a host file while the model still believes it edited the container, and `read` hands host content back as if it came from `/workspaces/…`. So the requirement the executor reads is enforced here as well, in the operation that would touch the host:

| requirement source | how the fs row learns it |
| --- | --- |
| a `… (devContainer)` preset | `callingContainerPreset(ctx)` (`src/refusal.ts`): the initiating Agent from `ctx.agents.currentInitiator()`, answered by `agentPresets.presetForSession` |
| `requireContainer: true` | the row's own config |

The initiator is the channel available to a filesystem call: the shell tools pass the calling agent's preset down as `dshEnv`, and `ctx.fs` has no such argument. The loop establishes the initiator around every turn, so a subagent's call is attributed to the subagent's own Session — the same answer `presetForSession` gives the `DSH_DEVCONTAINER` marker. A call made outside any turn (the settings page reading a file, a plugin's own bookkeeping) inherits no initiator and therefore no requirement.

The base directory is a fallback, not a blanket answer: a repository may claim a path only through ownership — a container path of that repository, a host path under its root, or a relative path that resolves (`..` included) to somewhere inside it. A host path elsewhere on the machine stays unowned, so a declaration in one repository cannot become the way to read `C:\Windows\…` or another project from a `(devContainer)` session.

When the requirement holds and neither the path nor an owning base directory belongs to a repository that declares a container, the call throws `FsError('FS_PERMISSION_DENIED')` carrying `fsRefusalText` — the preset id, the path, the four file names discovery looked for, and the two ways out. Nothing is read, written, or created. A repository that does declare a container is unaffected: the call is delegated to that container, and an ordinary preset in the same repository keeps the plain host filesystem.

The three mutations this build's base class does not declare are installed as own properties (`installTargetMutations`): a container-bound call becomes the matching RPC (`fs.patch`, `fs.delete`, `fs.move`, every target fenced first, both ends of a move), and an ordinary call still runs the inherited implementation — or reports `FS_IO_ERROR` when this backend has none — instead of failing as `undefined is not a function`.

The refusal sits at the seam rather than in the tools so no other consumer can slip past it: a `glob`/`grep` run, an instruction-file read, the working-directory check every tool makes, and a subagent's session directory all go through `ctx.fs`. The consequence is that such a session does not run at all — the turn reports the refusal (contained at the driver boundary: nothing reaches the host and the process does not crash) instead of proceeding on a degraded context. That is the intended state for a `(devContainer)` preset over a repository that declares no container, and the diagnostic names both ways out.

## `ctx.subprocess`: where a host process starts

`src/subprocess.ts` decorates the mounted seam. `spawn` is the one place a host child process is given a directory, and in a container-bound session the directory a caller names is a container path: `ctx.shell` reports `/workspaces/<repo>/…`, and the working directory the loop hands to `run_code` is whatever `ctx.fs.processPath` answers — the container path on a POSIX host (see [what the row still decides](#what-the-row-still-decides)) — which the PTC runtime passes straight to its worker's spawn. Nothing on the host can `chdir` there, so the spawn rejected with `ENOENT` before a line of the worker ran — the model saw a runtime failure where only the container was missing.

The seam is decorated rather than replaced. Cordis holds one implementation per service name, so a second `subprocess` provider row would be refused at activation, and every spawn that needs no rewrite — an ordinary session's shell, a language server in a host repository — must keep the provider's own process mechanics: the inherited method is called with its own receiver, and the caller's spec object is passed through untouched whenever nothing is mapped.

A directory is mapped only when a repository owns it. `repositoryOfPath` asks the shared discovery cache with the initiating Agent's own directories as anchors — its working-directory projection, then the project directory its Session header recorded, which is a host path because the Session was created on the host — and then with the cache alone, which is what a call made outside any turn has. `mapSpawnCwd` translates the container-side remainder onto `hostWorkspaceRoot` through `toHostPath`: POSIX remainder arithmetic plus the host root's own separator style, so a Windows, Linux, and macOS host run the same code and no drive letter is ever constructed. A host path, a relative path, a container path no declaration owns, and every ordinary session come back unchanged.

What the child then does is unchanged. The PTC worker's `tools.read`/`tools.write` calls arrive on the parent as the host functions it was given, which are `ctx.fs`, which is the Docker RPC pipe: the host directory is where a host process may start, never a place the session may read. `spawnTerminal` is deliberately not decorated — a terminal is a PTY on the host, and a container-bound session's terminal belongs to the container rather than to a host shell started in the repository root.

The decoration is installed inside `ctx.inject(['subprocess'], …)` from the Host row and removed with its effect, so a composition that mounts no subprocess provider is unaffected and unloading the Bundle gives the provider its own method back. Comparing the installed decoration uses the own property descriptor, not a read of the method: Cordis hands a service out through a traceable proxy that wraps every method read in a fresh function.
## `ctx.ptcRuntime`: where a program runs

`src/ptc.ts` decorates the mounted PTC runtime. Decorating `ctx.subprocess.spawn` does not reach it: the PTC seam is asked for a directory of its own and never hands its caller's spec to `spawn`. `resolve` takes `request.cwd` or, when the caller names none, the sandbox policy's `workspaceRoot` (`packages/ptc-runtime/ptc-runtime-node/src/execution.ts:76`), and `run` gives that directory to a worker whose entry program runs `process.chdir(cwd)` (`packages/ptc-runtime/ptc-runtime-node/src/process.ts:88`) before the first line of the program. The worker is a host Node process while a container-bound session's workspace root is `/workspaces/<repo>`, so the chdir failed with `ENOENT` and the model saw a runtime failure instead of its `tools.read` result.

Both entry points are decorated, for two different callers. `resolve` maps a directory the request names before the provider reads it, and — when the request names none — maps the directory the provider filled in from the policy, which is the case the chdir died on. `run` maps the spec's directory on entry, so a caller holding a resolved spec itself (a persistent runtime re-running for an owner, another plugin, a test) cannot put a container path in front of the worker instead.

The translation is `mapPtcCwd` over `toHostPath`, as for `spawn`: POSIX remainder arithmetic plus the host root's own separator style, so no drive letter is constructed and a Windows, Linux, or macOS host runs one code path. Ownership comes from the same discovery cache through `repositoryOfPath` and the same anchors, so a container path no declaration owns, a host path, a relative path, and every ordinary session pass through unchanged, and a request or spec that needed no mapping reaches the provider as the caller's own object. Only the directory moves: the sandbox policy, the program, the bindings, and the deadline stay the caller's, and the program's file access is `ctx.fs`, the container RPC pipe.

Like the spawn decoration it is installed inside `ctx.inject(['ptcRuntime'], …)` and removed with the effect, and the disposer checks the own descriptor before deleting each method, so a decoration another row installed afterwards stays in place. A composition that mounts no PTC provider mounts nothing.

## The `(devContainer)` guard

A derived preset promises "every command runs in the container". In a repository that declares no container the executor could fall back to the host shell — and that is the worst outcome available: the model still believes it is on Linux, writes Linux commands, and reads host-side failures as its own mistakes. So a session running a derived preset gets two layers instead.

### Knowing whose command it is

`shellEnv`-style environment is the only channel that reaches the executor with the calling agent attached. This row registers a `ctx.shellEnv` contributor (`src/index.ts`, `markContainerPresets`) that resolves `agentPresets.presetForSession(execution.agent.session)` per shell call and returns two managed variables when that id ends in `-devcontainer`:

| variable | value |
| --- | --- |
| `DSH_DEVCONTAINER` | `1` |
| `DSH_DEVCONTAINER_PRESET` | the preset id, e.g. `delegate-only-devcontainer` |

The shell tools already hand `ctx.shellEnv.collect(exec)` to the executor as `spec.dshEnv` (`packages/shell/tool-bash/src/index.ts:490`), so `execute()` reads the marker rather than inferring anything: a subagent running `subagent-coder-devcontainer` is marked exactly like the main agent running `delegate-only-devcontainer`, because `presetForSession` answers per Session. Values are recomputed per call, so switching presets mid-session needs no reload, and an ordinary preset yields no marker at all.

### First layer — the prompt says why before the first command

The `system-prompt/assemble` listener rewrites `working-directory:current` for a session that runs a derived preset (or any session when the row sets `requireContainer: true`) and a repository that declares a container. When the discovery walk finds **nothing** for such a session, it writes the refusal instead (`missingContainerContextText`, `src/prompt.ts`): the working directory, the preset id, the four file names it looked for, the fact that every shell command is blocked, and an explicit instruction to tell the user in Chinese that the repository needs a container configuration or the session needs an ordinary preset — plus "do not retry, do not call this a temporary failure". An ordinary preset over the same repository gets the untouched context.

### Second layer — the executor refuses instead of falling back

`DevcontainerShellExecutor.execute` asks `requiresContainer()` before anything else. When it holds and the workdir names no repository, the command is refused:

- `markedContainerOnly(spec.dshEnv)` — the marker above;
- `requireContainer: true` — a deployment that wants the guarantee for every preset, not only the derived ones;
- `internals.requireContainer` — the test seam.

A refusal is not an exception: it returns a **settled** `ShellExecution` (`status: 'completed'`, `exitCode: 1`, empty stdout, the diagnostic on stderr) built by `refusedExecution` (`src/refusal.ts`), so the tool renders an ordinary failed command and the model reads a failure it can act on. `kill()` is a no-op and `readOutput()` drains the diagnostic once, which is what the background/observed paths expect of a finished process. Nothing is spawned, no container is probed, and nothing can reach the host shell.

Ordinary presets in the same repository keep the local fallback described above: no marker, no refusal, PowerShell on Windows and bash elsewhere.

## The Linux prompt context

`src/index.ts` listens on `system-prompt/assemble` with `{ prepend: true }`. Prepend runs the listener **first**, so its `await next()` returns after `WorkingDirectoryService`'s own post-processing (`packages/session/working-directory/src/index.ts:90-97`), which is what puts the final `working-directory:current` text in the assembly. The listener then replaces that contribution with:

```text
Current working directory: "/workspaces/<repo>/<sub>".
Runtime environment: Linux Docker container (<label>) mounted from host directory "F:\…\<repo>". The active shell is Linux bash (/bin/bash). Always write POSIX/Linux commands and never PowerShell commands.
```

The host directory comes from `ctx.workingDirectory.get(session)` when the assembly carries an agent, and from parsing the existing context text otherwise (diagnostics assemble without an agent). `<label>` is the explicit container, else `service <name>`, else the repository directory name.

Nothing else in the prompt changes: the tool catalog, personas, and plan-mode text are untouched, so request-cache stability is unaffected.

## Windows shell tools and the `… (devContainer)` presets

A preset is declarative plugin **data**: `AgentPresetRegistry` validates an entry list and mounts it as a subtree (`packages/preset/agent-preset-registry/src/index.ts`, `mount.ts`). Two consequences shape this Bundle:

- a Loader patch entry can only reach a row by `id` in the composition — never a row nested in some preset's `config.plugins`;
- the registry exposes the roster, registration, and selection, but **no mutation** of a definition it already holds.

So an existing preset cannot be edited in place. What this Bundle does instead is derive:

1. once the Loader tree settles (`await loader.await()` from a detached task — awaiting it inside a row's own activation would wait on itself), it reads the raw `config` of every row named `@deepseek-ai/dsh-agent-preset`; **every** sync re-reads them, so a preset row inserted later is still derivable;
2. for each id in the stored `sources` list, it deep-clones that declaration and rewrites the clone, at any nesting depth. Every PowerShell row is disabled, and the dialect is read from the row, not only from its module: `terminal-bash` carries both (`shellDialect: pwsh` is how `minimal` declares its PowerShell terminal). Every POSIX row ends up enabled, but a *persistent* or *terminal* bash row (`tool-bash-persistent`, `terminal-bash`) cannot keep its module: those tools spawn and own a shell process on the HOST, which is the case this Bundle exists to remove, and on Windows the second terminal backend fails activation outright (`a PTY backend named "shell" is already registered`) so the whole derived preset mounts as `broken` and vanishes from every picker. Such a row becomes the ordinary `tool-bash` row — the one shell tool that asks `ctx.shell`, and therefore the container — with the terminal-only config dropped; only the first one does, because a second would mount a duplicate `bash` tool, and when the source already mounts `tool-bash` (`standard`) each persistent row is merely disabled. Nothing is inserted, so a variant never gains a tool its source did not mount: `delegate-only` mounts no shell tool at all, and `delegate-only-devcontainer` mounts none either — only the subagent presets it routes to get `bash`;
3. every `tool-subagent` route is pointed at the derived variant of *that* preset, recursively and depth-bounded, so a derived `coder` delegates to the derived `workflow-runner` and so on. A route names its preset two ways and both are rewritten: the fixed `config.agentPreset` and every entry of the array form `config.allowedAgentPresets` (`packages/subagent/tool-subagent/src/preset-selection.ts:9`), which is what a preset uses when the caller may choose among several subagent presets. The route-following is depth-bounded (`MAX_VARIANT_DEPTH`, 4), and the cap cuts rather than falls back: a route to a declared preset whose variant already exists elsewhere in the plan is pointed at that variant, one whose variant does not exist is removed — an `allowedAgentPresets` entry is dropped, a fixed `agentPreset` disables its whole row, and the variant's description says the deeper routes are disabled. Leaving the ordinary preset on the route would start that subagent on the host while the calling agent still believes every command runs in the container. A route this composition never declares keeps its id, because the plan cannot register a variant for a preset it cannot read either, and a route a preset makes back to itself becomes its own derived id. The cap is also what terminates a cyclic route graph;
4. each derived declaration is registered under `<source>-devcontainer`, named `<source name> (devContainer)` and ordered just after its source. The same machinery derives a second track, `<source>-sbx` / `<source name> (sbx)`, from the `sbxSources` list — see [Docker Sandbox](#docker-sandbox-sbx).

The user sees an extra entry in the preset picker; selecting it composes a roster whose shell tool is `bash` and whose subagent routes stay inside the derived family. Every derived preset is unregistered when the Bundle unloads, and a failed registration only drops that variant (its routes then keep their original target).

### The set is a setting, not a constant

`sources` is a **volatile** config field, so it is the one field the settings page can write: the write lands in the profile patch (survives a restart) and is committed into this row's live reference without a remount. The row then applies the difference through `VariantSync` (`src/variants.ts`), keeping one serialized queue so two quick toggles cannot interleave:

- a newly checked source registers itself **and** every subagent variant its routes reach, dependencies first;
- an unchecked one is disposed immediately, dependants first, using the disposer `agentPresets.register` returned;
- an unchanged list touches nothing at all.

Two events re-derive the set, on the scope `ctx.inject(['loader', 'agentPresets'])` opens:

- `settings/document-updated` (`packages/settings/settings/src/index.ts:317`), which carries the owning Loader entry's `id` rather than a namespace name, so the listener does not filter by name: a row loaded under a custom id follows its own writes too, and an unchanged list costs one no-op sync;
- `loader/volatile-update`, the commit that actually carries a volatile field's new value into this row, emitted on this row's own fiber (`vendor/loader/src/config/entry.ts:191-194`).

Both are needed: the settings event says a write happened, the volatile commit says what the row now reads.

The sync is built inside `ctx.inject`, not at mount time, and that placement is load-bearing. `agentPresets` is provided by a Profile-patch row that activates **after** this Bundle's inserted rows, so a lookup made during `apply` finds nothing; memoizing that lookup (the obvious lazy-init shape) then pins "no registry" for the life of the process — the page keeps its checkbox, the write lands in the patch, and nothing is ever registered. `ctx.inject` holds the callback until both services exist and re-runs it if either goes away, so the derived set follows the composition and a write that lands while the tree is still mounting is applied afterwards instead of being dropped.

**Nothing is derived by default.** `sources` starts empty, so a fresh install registers no `…-devcontainer` preset and the picker looks exactly as it did before.

The page (`src/client/`) is a `settings.section` of its own — order 31, after the preset-visibility page — listing the roster minus the `…-devcontainer` ids, so a variant can never be offered as a source of another variant. Each row shows the preset name, its id and description, a checkbox for the stored list, and the Host's own answer: a checked row is tagged *Available* once its variant is in the roster, and *Wait for it* while it is not (a refused or failed registration). A preset the registry could not mount (its roster row carries `broken`) is tagged *Cannot load* and its checkbox is read-only, because its variant could not mount either; a row that is already stored can still be cleared. A **variant** that registered but could not mount carries its own `broken` text, and that row is tagged *Variant cannot mount* in the error tone, with the registry's diagnostic as the checkbox title — never *Available*: pickers hide a `broken` row entirely (`packages/client/ui-agent-preset/src/client/settings-store.ts:107-122`), so a green badge there would promise a preset the person cannot select anywhere.

A registered or disposed variant is a roster change no surface hears about by itself. The shipped pickers re-read `agentPresets.list` on `settings/document-updated` **for the preset registry's own namespace** (`packages/client/ui-agent-preset/src/client/index.ts:164-167`), and on `connection/reset` — a registration made here is neither. So when a sync actually changes the derived set, this row emits that same event for `agent-preset-registry` on the root context (`src/index.ts`, `PRESET_REGISTRY_NS`), which is the one roster-refresh signal a third-party registration can reach, and an open picker updates without a reload. Clients receive it through the forwarded-event allowlist (`packages/api/remotes/src/remote-events.ts:54`).

A write and a registration do not happen at the same instant: the settings event is emitted first, the sync walks the presets afterwards. So after a landed write the page re-reads the roster immediately **and** keeps re-reading with backoff (80/150/300/600 ms) until every checked row's variant is present, which is what keeps a freshly checked row from sitting on *Wait for it* for the rest of the session. The badge text is the row's accessible name (the shipped `Checkbox` takes only `label`/`title`; it does not forward `aria-describedby`), and the description carries a stable `dcv-description-<id>` id.

**What this does not do:** it never touches `delegate-only`, `standard`, or any other source preset, which is why those keep their Windows `pwsh` tool exactly as before — existing behaviour is preserved. It also does nothing on non-Windows hosts by default (`presets.win32Only`), where the flip would produce a pure duplicate.

The mechanism relies on two Loader facts: `entry.options.config` keeps the **raw** declaration, with `!!js` expressions still present as `{ __jsExpr: '…' }` markers (`vendor/loader/src/config/utils.ts` → `isJsExpr`), and re-registering plain data through `prepareProfileEntries` evaluates those markers the same way the original row did. Rows this Bundle does not touch keep their platform expressions; the shell rows get a literal boolean instead, which is the point.

### Config knobs

| field | default | meaning |
| --- | --- | --- |
| `shell` | `/bin/bash` | default container shell |
| `cli` | `auto` | default driver (`auto`, `devcontainer`, `docker`, or `sbx`) |
| `ensureUp` | `true` | may `devcontainer up` / `sbx create` run |
| `containerTimeoutMs` | `300000` | budget for one probe, `devcontainer up`, or `sbx create` |
| `rpcTimeoutMs` | `60000` | budget for one container filesystem request (fs row only) |
| `sources` | `[]` | source preset ids to derive `… (devContainer)` variants from; **written by the settings page**, empty derives nothing |
| `sbxSources` | `[]` | source preset ids to derive `… (sbx)` variants from; written through the profile patch |
| `presets.enabled` | `true` | derive at all |
| `presets.win32Only` | `true` | derive only on Windows |
| `presets.orderOffset` | `1` | added to the source `order` |

The two display suffixes are not knobs: the shell row reads a preset's id back to decide which `DSH_*` marker to set, so `src/ids.ts` owns both the suffix and the label.

A row that declares no `config:` receives the schema's defaults, and the Host row also survives a config that arrives empty or absent — the derived set is read through `VariantSync`, whose source list falls back to "nothing derived" rather than throwing.

Both service rows are configured independently; a Profile patch can pin `cwd` for either of them like any other row. The shell row additionally carries the local-executor knobs (`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`) and the two fallback fields above.

## Docker Sandbox (`sbx`)

Docker Sandboxes run an agent in a microVM that mounts a host workspace at a path of the sandbox's own: the absolute host path on a Linux or macOS host, and the drive-letter spelling of it (`/f/personal/repo` for `F:\personal\repo`) on a Windows one. That one fact is why this Bundle can offer a second track: a `(sbx)` preset needs no `.devcontainer/devcontainer.json`, because there is no build to describe — only a directory to mount.

### Discovery and naming

A sandbox is found by name, and the name is derived from the workspace so it is stable across sessions: `dsh-<repo>-<8 hex of the normalized path>` (`sandboxNameFor`). Two repositories with the same directory name therefore never share a sandbox, and a declaration may pin its own name with `sandbox` / `sandboxName`.

`resolveSbxTarget` (`src/sbx.ts`) runs the same probe-then-prepare shape the container drivers use:

1. `sbx ls --json` — the structured listing is the documented contract; the older `{ "sandboxes": [...] }` envelope is accepted too, and a row that says nothing about its state counts as **not running**, because starting an existing sandbox again is harmless while treating a stopped one as running would make every later `sbx exec` fail with exit code 125 and never recover;
2. a sandbox listed as running is used as it is, with no further CLI call;
3. with `ensureUp` (the default), a missing sandbox is created around the workspace (`sbx create --name <name> shell <hostWorkspaceRoot>`) and then started detached (`sbx run --detach --name <name>`) — `sbx create` alone leaves it stopped once the creating session ends. An existing but stopped sandbox is only started;
4. with `ensureUp: false` the resolver reports the state instead of changing it, naming the command that would fix it;
5. an `exitCode: null` from the CLI means the program is not installed at all, which no retry can fix: the diagnostic says so (`SBX_INSTALL_HINT`) instead of reporting a missing sandbox.

### Where commands run

`sbx exec` starts its own process and takes no environment flags on the CLI version this Bundle targets, so the argv is one POSIX wrapper:

```text
sbx exec <name> -- /bin/sh -c "cd -- '<workdir>' && exec [env 'K=V'…] '<shell>' -c '<command>'"
```

The `env` prefix appears only when something is forwarded (`remoteEnv`, the caller's entries, and the `DSH_*` snapshot minus this Bundle's own markers), and it is how a sandbox command sees the same entries `docker exec -e` would have given it. The workdir is the path the sandbox reported for the workspace (`sandboxMountFor`), so the wrapper enters a directory that exists there; `toContainerPath` still maps a host spelling onto that mount, and on a host whose sandbox mounts the workspace at its own absolute path the translation reduces to normalization. The `ctx.subprocess` / `ctx.ptcRuntime` decorations keep working unchanged.

One exception, and it is the interesting one: a declaration that names `cli: "sbx"` itself is taken at its word about `workspaceFolder`, because that repository has opted into the sandbox driver and a host that does not reuse the native path needs the escape hatch. Everything else is mounted where the listing says, and falls back to `sandboxWorkspacePath` — the drive-letter spelling on Windows — when the row reports no mounts, which is also the spelling a `(sbx)` session's filesystem calls are measured against.

### The filesystem channel

The RPC channel speaks to a runtime, not to Docker (`ChannelTarget`): `docker exec -i <container> …` or `sbx exec -i <sandbox> -- …`. Staging the helper, the handshake, and every operation are identical, so a `(sbx)` session's `ctx.fs` performs its I/O inside the sandbox with the sandbox's own Linux `node`, and the containment rule is unchanged — the helper's workspace is the mount point, and nothing outside it is reachable.

A `(sbx)` filesystem call is attributed to its repository before that round trip, and the mount a session names is not the host spelling the specification was built from. `prepareSbxMount` therefore asks the runtime once — the same probe the first call would have run — so the listing's mounts are on record before the path is measured against them, and `containerMountsOf` accepts every spelling of the mount: the specification's folder, the drive-letter spelling, and the realpath the channel reported. A path that is still outside all of them is refused locally, with no round trip: a sandbox session cannot read `/etc/passwd` any more than it can read a neighbouring repository.

The directory behind such a path is recovered, never assumed from the row's own settings. One row serves every session on the host, so its configured `cwd` is the directory DSH itself started in — under `dsh web` that is the installed Bundle, not the workspace a session was opened in — while a `(sbx)` session names its workspace in the sandbox's spelling, which has no host ancestry for the discovery walk to follow: `/f/personal/repo` is `F:\personal\repo`, one namespace away from the directory that declares the container. `sandboxHostPathFor` (`src/sbx.ts`) reverses it before `repositoryFor` gives up. A mount the listing reported decides on its own, deepest first, and names both the host directory and the workspace root it belongs to — which is what attributes a workspace that declares no container at all. The drive convention alone names no workspace root, so it decides only when a repository really declares a container above the directory it spells; `/f/…` therefore cannot claim whatever host path it happens to name, and a sandbox path outside every mount is still refused before the first round trip.

### The two preset tracks

`sources` derives the Dev Container track, `sbxSources` the sandbox track, and `planVariants` plans both in one pass (`src/presets.ts`). They are independent by construction: the same source can appear on both lists and derives two trees, and a track only ever routes its subagent rows into its own variants — a sandbox subagent under a Dev Container root would run commands in a different runtime than the agent that delegated to it. Ordering, the depth cap, the "cut instead of fall back" rule, and the shell-tool flip are shared, so a `(sbx)` variant of `delegate-only` mounts no shell tool either.

The markers follow the track: `DSH_DEVCONTAINER` / `DSH_DEVCONTAINER_PRESET` for a container, `DSH_SBX` / `DSH_SBX_PRESET` for a sandbox. `markedVariantKind` reads them back for a shell call, and `callingVariantKind` answers the same question for a filesystem, subprocess, or PTC call through the initiator boundary.

Unlike a `(devContainer)` preset, an `(sbx)` preset never refuses for a missing declaration: the workspace is mounted as it is. It refuses only when no host directory can be named at all — a row mounted without `cwd` and a relative workdir, since a workdir in the sandbox's own spelling names the host directory it stands for (see [the container executor](#ctxshell-the-container-executor)) — and the diagnostic says which setting fixes that.

## Verification status

`pnpm --filter @banzhe/dsh-devcontainer typecheck`, `… test` (478 cases across 29 files), `… build`, and `pnpm lint` all pass. The tests cover the RPC layer (frame encoding and decoding across chunk boundaries and invalid lengths, the channel handshake over a real child process answering `fs.resolve` and `fs.readText`, a remote failure keeping its `FS_*` code, cancellation, a helper that never answers its handshake, a container that refuses the staged helper, transport loss failing pending calls, and the pool re-opening after the container dies), the helper program driven directly (handshake and ping, path anchoring including the drive-mangled spelling, metadata, text and byte windows, streaming, listings, create and update with both guards, literal edits with CRLF preservation, hunks, delete, move, and the POSIX-to-`FS_*` error mapping), the row's delegation through a real helper (resolve from both spellings, reads, listings, write, edit, patch, move, delete, the escape refusal for a link out of the mount, a host path outside every repository, failure isolation with a container re-probe, and the polling watcher), the Session directory a Windows-rooted container target yields (the host path instead of the sandbox spelling, a subdirectory of it, the `.git` probe the project walk builds from it, and the sandbox spelling still on the wire), the delegation a `(sbx)` session runs over a stub channel (the drive-letter path its sandbox mounts the workspace at, a path below it, the host spelling of it, a host path outside it, a repository that declares a container attributed through that spelling, a mount a listing reported that differs from the host convention, the sandbox spelling of a workspace attributed while the row is configured with a different directory, a path below it, an unmounted path still refused, and the reverse of both the drive convention and a reported mount, deepest mount winning), JSONC parsing, discovery and priority, both translation directions (mixed separators, drive-letter case, relative paths, `/workspaces/…`, drive-mangled spellings), container target resolution and the assembled argv, the directory a container-bound session hands `ctx.subprocess.spawn` (the mount point itself, a subdirectory, the mixed-separator spelling of both, a host path, a foreign container path, a look-alike sibling directory, the discovery-cache anchor a call outside any turn has, and the method the provider gets back when the row unloads), the directory it hands `ctx.ptcRuntime` (an explicit `cwd`, a request without one inheriting the policy's workspace root, `run`, a host path and a foreign container path left alone, a method another decoration installed afterwards left in place, and both methods back when the row unloads), `resolve`/`execute` of the shell row including the host-cwd guard, the workspace a sandbox-spelled workdir names (a row mounted without `cwd`, and a declaration found above the directory it spells), environment isolation, and both local-fallback shells, `resolve`/`lstat` of the fs row plus its container guard (a derived preset over a repository that declares none is refused with `FS_PERMISSION_DENIED` on the ingress path, on the pre-resolve probe, and on a target that predates the requirement; the same repository with a declaration still maps and reads; a host path outside that declaration, and a relative path climbing out of it, are refused; an ordinary preset still writes and still reaches paths outside the repository), a link inside the repository that resolves outside it (a junction to a host directory: `readText`, `streamText`, `readBytes`, `listDir`, and `stat` are refused with `FS_PERMISSION_DENIED` naming both spellings, a write through it lands nowhere, and an ordinary preset still reads through the same link), the environment the Docker / Dev Container CLI is started with (allowlisted names kept, the `DOCKER_*` family kept, credential-shaped names dropped even there, and a spawned CLI that cannot see an unrelated host variable), the defensive wrapper for mutations this build's base class does not declare (refused before the inherited implementation runs, both ends of a move, and still delegated for an ordinary session), the caller lookup behind it (initiator present/absent, ordinary preset, a registry that cannot answer), the prompt rewrite, and the preset plan — including the case that matters most, `delegate-only` deriving to a variant that still mounts no shell tool while its subagent routes get `bash`. The variant set is covered at three levels: `VariantSync` alone (difference application, idempotence, serialization, a refused variant), the Host row end to end (nothing derived on an empty list, a settings write registering a source and its subagent variant without a restart, a cleared box disposing it, the roster announcement on an actual change and its absence on a no-op sync), and the page (pure row rules, the controller's queue and refusals, and the rendered section under jsdom). The cache is covered directly (a declaration that appears after a miss, an edited one, a deleted one, a container path whose file vanished, two repositories that share a mount point, the index bound), the executor's container-target recovery is covered by a dead-container failure followed by a re-probe, and the preset plan covers the persistent/terminal shell rows (one `tool-bash` out of them, every other shell row disabled, the PowerShell terminal recognized by its dialect) and `allowedAgentPresets` — including the diamond route that reaches one preset twice. The guard is covered on both layers: the marker contributor (derived preset → both variables, ordinary → none), the prompt warning versus the container context versus the untouched ordinary context, and the executor's refusal (exit 1, diagnostic on stderr, no container probe, no host process) against the unchanged lo... (line truncated to 2000 chars)

Not covered by the suite, and not yet exercised against a live daemon (Docker Desktop was not running in the development environment):

```sh
docker run -d --name devcontainer-smoke -v /path/to/repo:/workspaces/my-repo -w /workspaces/my-repo ubuntu sleep 600
# .dsh/docker.json = { "container": "devcontainer-smoke", "workspaceFolder": "/workspaces/my-repo" }
# a bash tool call in that repository should report /workspaces/my-repo and print a Linux `pwd && uname -a`.
```

The first live run is therefore the real proof of the three external contracts: the Dev Container CLI's `containerId` envelope, the `devcontainer.local_folder` label value on Windows, and the bind-mount mapping of `workspaceFolder`.

The sandbox track has the same status. Its unit tests pin the naming, the listing parser (both JSON shapes, a row with no state, unparsable output), the create/start sequence, the missing-CLI diagnostic, the `ensureUp: false` refusal, and the argv — but the CLI itself was not available in the development environment. On a host with `sbx` installed:

```sh
sbx create --name dsh-smoke shell /path/to/repo
# profile: devcontainer row -> sbxSources: ['standard']
# a bash tool call in that repository should print a Linux `pwd && uname -a`,
# and `ctx.fs` reads/writes should land inside the sandbox.
```

The page is exercised against a jsdom render and a fake form, and the Bundle is installed in the `web` and `desktop` Profiles of this machine (`link:` against the source tree) where `dsh web` boots it with no activation failure for any of its three rows. A roster answer that reports success without a body — a build that serves no `agentPresets` namespace — leaves the page empty instead of throwing during plugin activation.
