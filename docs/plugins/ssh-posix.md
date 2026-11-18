# ssh-posix — implementation notes

Moved out of the plugin's README, which now covers only what the Bundle contributes and how to install it.

## What the fork is

`plugins/ssh-posix/src/` is a copy of `packages/ssh/ssh` from DeepSeek Harness `my_dev @ 3a01e5a`, keeping the client half of that package and none of its remote half:

| File | Origin |
|---|---|
| `src/index.ts` | the shipped `SshConnection` service, with the five changes below |
| `src/protocol.ts` | verbatim; `SSH_PROTOCOL_VERSION = 3` |
| `src/schemas.ts` | verbatim |
| `src/stream-security.ts` | verbatim |
| `src/local-endpoints.ts` | new: the local temporary directory and the loopback forwarding endpoint |
| `src/target-shell.ts` | new: the remote launch command and its POSIX quoting |

`helper.ts`, `helper-processes.ts` and `helper-entry.ts` are **not** forked. The remote helper is a digest-verified artifact installed on the target host, reached through `launch.kind` `executable` or `node-script`; a client fork has no reason to carry a second copy, and the digest comparison would reject it against any deployed artifact.

The service key is still `ssh` and the `Config` fields are unchanged, so the shipped `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh` and `@deepseek-ai/dsh-sandbox-ssh` providers bind to this service with no configuration of their own. There are no credential fields: authentication stays with the OpenSSH alias.

## The five changes

1. **Capability probe instead of a platform refusal** (`probeClient()`, `probeSshClient()` and `multiplexesClient()` in `src/index.ts`). The shipped constructor throws `SSH runtime requires a POSIX client` on any non-POSIX host. Here startup first runs `ssh -V` with the configured request deadline and no console window, and decides the forwarding mode from the answer:
   - the client exited zero and identified as OpenSSH on a POSIX host → `multiplexed`;
   - the client exited zero but did not identify as OpenSSH, or the host is Windows → `per-stream`;
   - the client did not run (missing binary, non-zero exit without a banner, deadline) → startup rejects with `SSH client 'ssh' is unusable on <platform>: <reason>`, naming the command and the platform, before any helper process exists.

   A connection closed while the probe is in flight reports the shipped `SSH connection closed before startup` instead, so disposal reads the same as before.
2. **Temporary directory from `os.tmpdir()`** (`createTemporaryDirectory()` in `src/local-endpoints.ts`, called from `start()`). `join(tmpdir(), 'dsh-ssh-')` replaces the hard-coded `/tmp/dsh-ssh-`. The directory is allocated only in the multiplexed mode that uses it for the control socket and the stream sockets; `dispose()` removes it under the same guard as before.
3. **Local stream endpoints** (`forwardThroughMaster()` multiplexed, `forwardThroughProcess()` per-stream). The POSIX path is the shipped one: reserve `-O forward` to a socket inside the temporary directory, connect to it, authenticate, and cancel the reservation plus delete the socket when the stream closes. The Windows path reserves an unused loopback port (`reserveLoopbackPort()` in `src/local-endpoints.ts`), starts one `ssh -L 127.0.0.1:<port>:<remote socket>` child for the stream (`StreamChild` in `src/index.ts` owns the child, its spawn failure, its `status()` and its diagnostics), waits for that listener while the client is still authenticating (`connectLoopback()`), and then runs the same connect-and-authenticate tail. A spawn failure is the stream's failure; a child that exits reports its exit code or signal, with a bounded standard-error tail; cancellation, a failed connection or a closed stream terminates the child with SIGTERM and SIGKILL escalation through `StreamChild.stop()`, and `dispose()` joins every child it started (`stopStreamChildren()`).
4. **Connection reuse** (`start()`). The multiplexed mode keeps `-M -S <control> -o ControlPersist=no` and every `-O` command. The per-stream mode passes none of them and issues no control command at all, so it never depends on Win32-OpenSSH multiplexing; the master it starts is an ordinary `ssh -T ... <host> <command>` carrying only the administrative channel. Both spawns share one option table for the options they have in common; the master adds `ClearAllForwardings=yes`, the stream child adds `ExitOnForwardFailure=yes`.
5. **Remote launch command into `target-shell.ts`** (`launchCommand()` in `src/target-shell.ts`, called from `start()`). `launchCommand(launch, helper)` builds the same two command strings the shipped service built inline, including `'\''` quoting and the `NODE_OPTIONS='--disable-sigusr1'` form for an executable, and publishes the configured PTC bootstrap fields. Quoting is POSIX-only because the helper runs on a POSIX host; the module owns `HelperLaunch`, which `src/index.ts` re-exports.

Two smaller Windows adaptations ride along: the connection, the stream child and the probe command pass `windowsHide: true` so a Windows host does not flash a console window (the `-O` control commands of the multiplexed mode keep the shipped `execFile` call, which that mode is the only reachable caller of), and the per-stream child omits `ClearAllForwardings=yes` — that option also clears command-line forwardings, which would drop the `-L` the child exists for.

## Forwarding modes

| Local host | Client answer | Mode | Streams | Control socket |
|---|---|---|---|---|
| Linux / macOS | exited zero and identified as OpenSSH | `multiplexed` | `-O forward` to a Unix socket in the temporary directory | one master, `-M -S` |
| Linux / macOS | exited zero, not identified as OpenSSH | `per-stream` | one `ssh -L` child per stream | none |
| Windows | anything that ran | `per-stream` | one `ssh -L` child per stream | none |

Win32-OpenSSH's `-M`/`-S`/`-O` behaviour and its Unix-socket forwarding are not verified anywhere in this repository, so a Windows host never bets on either. The probe decides once per connection; a connection never switches mode afterwards, and the decision has no user-visible output.

## The remote-only profile layer

`cordis.patch.yml` turns the profile into a remote world rather than adding to one:

- rows disabled: `fs-sandbox`, `subprocess`, `sandbox` (the local providers), `tool-pwsh`, `pwsh-sandbox`;
- rows enabled: `tool-bash`, `bash-sandbox` — the remote helper runs on POSIX, so the POSIX shell tool is the one that matches the execution world even when the local host is Windows;
- rows inserted: `ssh-posix`, then `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh`, `@deepseek-ai/dsh-sandbox-ssh`;
- the `sandbox-policy` row is overridden. The shipped base row derives `workspaceRoot` from `process.cwd()`, which on a Windows host is a `C:\` path, while the remote helper accepts only absolute POSIX paths. The override names a remote workspace and repeats the shipped `mode` expression, because a patch replaces a row's whole config. Loading a bundle patch over a base row's config this way is the arrangement `packages/bundle/headless/cordis.patch.yml` uses for the same row.

The three provider packages are not part of a stock DSH installation, so this layer only activates where the profile can resolve them. Loading it into a profile that also serves local work is a mistake, not a configuration: every file path, process and sandbox root afterwards refers to the SSH host.

## Configuration

The connection keeps the shipped fields; nothing here is new.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Existing OpenSSH host alias, with its user, key and known-host entry |
| `launch` | required | `{ kind: "executable" }` or `{ kind: "node-script", node: "/absolute/node" }`, optionally with `bootstrapPath` + `bootstrapHash` |
| `helper`, `workspace` | required | Absolute remote helper entry and default workspace |
| `helperHash` | required | Lowercase SHA-256 of the installed helper entry |
| `requestTimeoutMs` | `30000` | Probe, connection and administrative-request deadline |
| `maxFrameBytes` | `67108864` | Per-message JSON payload ceiling |
| `maxPending` | `128` | Ordinary outstanding requests |
| `leaseMs` | `30000` | Helper heartbeat lease |

`config.workspace` and the patched `sandbox-policy` `workspaceRoot` name the same remote directory: the first is the helper's default workspace, the second is the write root the sandbox policy grants. The profile patch must set both to the same path.

The remote host still needs the POSIX helper installed, outside the workspace and outside any replaced temporary tree, exactly as the shipped package documents.

## Adaptations the fork needed

1. **Package identity and build.** Name `@banzhe/dsh-ssh-posix`, loader id `ssh-posix`, plain `tsdown` config with `fixedExtension: false` (so `lib/index.js` matches `main`/`types`, as `plugins/web-icons` does). `protocol.ts`, `schemas.ts` and `stream-security.ts` are copied byte for byte.
2. **Dependency sections.** `@deepseek-ai/*` peers are caret ranges matching the DSH release this fork was built against; the copied manifest's `workspace:*` specifiers cannot be published. `@deepseek-ai/dsh-brand` was added to the workspace catalog for that reason. `zod` is a regular dependency (catalog specifier), as in the shipped package and in `plugins/agent-preset-per-workspace`.
3. **Ported specs run the POSIX arrangement anywhere.** `tests/startup-behavior.spec.ts` and `tests/connection-disposal.spec.ts` mock `process.platform` as `linux` (the upstream specs instead skip entirely on Windows), and their `execFile` doubles answer the `-V` probe with a POSIX OpenSSH banner. Control-command assertions count only non-probe calls, through a `control()` helper.
4. **The upstream platform-refusal test is gone.** `startup-behavior.spec.ts` no longer asserts that a `win32` client is rejected; `tests/windows-host.spec.ts` asserts the opposite and covers the probe, both modes, the stream-child failure paths and the reclamation paths.
5. **One disposal assertion changed.** The upstream test expected the temporary directory to be created and removed when disposal lands before startup; the probe now precedes allocation, so that test expects no directory at all. The failure it guards against (a spawned child after disposal, a leaked directory) still fails the test.
6. **Thirteen upstream spec files are not ported.** Eleven of them need the remote helper source this Bundle does not own — `collection.spec.ts`, `helper-boundaries.spec.ts`, `helper-cleanup-join.spec.ts`, `helper-failure-settlement.spec.ts`, `helper-finalization.spec.ts`, `helper-lifecycle.spec.ts`, `helper-processes.spec.ts`, `helper-runtime.spec.ts`, `stream-capability.spec.ts`, `stream-lifetime.spec.ts` and `stream-rebind.spec.ts` import `helper.ts` or `helper-processes.ts` directly, or through the in-process harness in `tests/fixtures/helper.ts`. `inspector-signal.spec.ts` imports neither: it asserts the shipped `sandbox-local` signal hardening, which is not this Bundle's surface. `live.e2e.ts` does import the forked `src/index.ts` but needs a reachable POSIX host with an installed helper, so it stays a real-machine suite.
7. **A copy would cost more than it proves.** Running the eleven helper specs here would need the helper sources vendored into `tests/` or a dependency on the published `@deepseek-ai/dsh-ssh`; either way the assertions would describe code this package does not ship. The eight ported files cover every forked module.

## Test inventory

`pnpm -C plugins/ssh-posix test` runs 9 files and 110 tests:

| File | Tests | Covers |
|---|---|---|
| `tests/protocol.spec.ts` | 4 | framing, cancellation, remote errors |
| `tests/protocol-boundaries.spec.ts` | 25 | frame and queue limits, malformed frames |
| `tests/protocol-disposal.spec.ts` | 3 | peer disposal |
| `tests/management-capacity.spec.ts` | 18 | reserved management capacity |
| `tests/identifiers.spec.ts` | 1 | branded process and stream ids |
| `tests/stream-timeout.spec.ts` | 1 | TLS-PSK stream authentication deadline |
| `tests/startup-behavior.spec.ts` | 30 | startup identity, config rejection, streams, disposal |
| `tests/connection-disposal.spec.ts` | 10 | establishment and disposal interleavings |
| `tests/windows-host.spec.ts` | 18 | the cases below |

The Windows cases: a Windows host starts and spawns instead of refusing; a stream becomes a loopback listener with a `127.0.0.1:<port>:<remote path>` `-L` specification; the per-stream child carries exactly the shipped option set; a refused first attempt is retried until the client's listener exists; a refused listener past the deadline fails with the endpoint named; a child that exited before accepting reports its exit code, and one that was signalled reports its signal; a spawn failure is the stream's failure; a failure carries the client's standard-error tail, of which only the trailing 4 KiB survives; closing the stream kills its child; a child that ignores SIGTERM is killed outright before disposal completes; a live child is joined by disposal rather than abandoned; the temporary directory comes from `os.tmpdir()`; the POSIX master arguments and remote command equal the shipped ones; the target-shell policy reproduces the shipped quoting; an unusable client fails loudly and spawns nothing; a non-multiplexing client falls back to per-stream.

## Known limitations

- **No Windows remote target.** The helper, the wire schemas (`remotePath` in `src/schemas.ts` requires an absolute POSIX path) and the `linux | darwin` platform field all describe a POSIX target. Connecting to a Windows SSH host is a separate contract: it needs a rewritten helper, a win32 packaging target and a Windows `sshd` to verify against.
- **Win32-OpenSSH is unverified end to end.** No test in this repository runs a real `ssh` client; the per-stream arrangement is proven against mocked transport only. A real POSIX target is required to confirm it, and the shipped `live.e2e` harness reads `DSH_SSH_TEST_CONFIG` for exactly that.
- **The port reservation is advisory.** The loopback port is released before the client binds it; a lost race surfaces as an `ExitOnForwardFailure` error rather than a retry on another port.
- **Stream count is the consumer's decision.** This Bundle sets no ceiling on concurrently forwarded streams; the administrative channel's `maxPending` bounds requests, not channels.
- **Web views still assume the host filesystem.** The shipped SSH documentation says so: replacing the providers does not make workspace views remote-aware. Use a headless profile, or expect the file-oriented UI to describe the local machine while the agent works remotely.
- **The profile layer needs providers a stock installation lacks.** `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh` and `@deepseek-ai/dsh-sandbox-ssh` must resolve in the profile's dependencies.
- **The helper-internal and real-machine suites are not part of this package.** See adaptations 6 and 7.
- **A stream failure quotes the client's own standard error.** The per-stream path appends a bounded stderr tail to the failure text, which is the useful half of an OpenSSH refusal (`Permission denied (publickey)`, a host-key complaint) and also whatever else the client chose to print — the configured host alias, a `known_hosts` or identity-file path. That text reaches a model as an error message; the shared master keeps standard error suppressed, as the shipped service did.
- **The patched write root is a placeholder.** `sandbox-policy.workspaceRoot` ships as `/home/deploy/project` in this Bundle's patch, standing in for the deployment's remote workspace. Override it together with the connection's `workspace`; a deployment that forgets gets a sandbox rooted at a path that usually does not exist on the SSH host, and nothing fails loudly at load time.

## Release status

This Bundle is in development. Two mechanisms hold it out of the release pipeline: `"private": true` in `plugins/ssh-posix/package.json`, which keeps the release workflow's publish step away from it, and an `ignore` entry for `@banzhe/dsh-ssh-posix` in `.changeset/config.json`, which keeps the version PR from bumping it. The changeset describing the first release stays in the working tree and is deliberately not committed — an unreleased changeset never reaches a version PR.

Cutting the first release is one change: drop `"private": true`, drop the `ignore` entry, and add the changeset. The ordinary version PR then publishes it.

## Credits

Forked from `@deepseek-ai/dsh-ssh` in DeepSeek Harness (MIT © DeepSeek), `my_dev @ 3a01e5a`. License: MIT.
