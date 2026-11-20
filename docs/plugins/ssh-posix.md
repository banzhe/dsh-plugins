# ssh-posix — implementation notes

Moved out of the plugin's README, which now covers only what the Bundle contributes and how to install it.

## What the fork is

`plugins/ssh-posix/src/` is a copy of `packages/ssh/ssh` from DeepSeek Harness `my_dev @ 3a01e5a`, keeping the client half of that package and none of its remote half:

| File | Origin |
|---|---|
| `src/index.ts` | the shipped `SshConnection` service, with the six changes below |
| `src/protocol.ts` | verbatim; `SSH_PROTOCOL_VERSION = 3` |
| `src/schemas.ts` | verbatim |
| `src/stream-security.ts` | verbatim |
| `src/local-endpoints.ts` | new: the local temporary directory and the loopback forwarding endpoint |
| `src/target-shell.ts` | new: the remote launch command and its POSIX quoting |
| `src/provision.ts` | new: release-archive inspection and the remote probe, transfer, extract and link commands |

`helper.ts`, `helper-processes.ts` and `helper-entry.ts` are **not** forked. The remote helper is a digest-verified artifact installed on the target host, reached through `launch.kind` `executable` or `node-script`; a client fork has no reason to carry a second copy, and the digest comparison would reject it against any deployed artifact.

The service key is still `ssh` and the `Config` fields are additive — `helperHash` became optional and `provision` is new — so the shipped `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh` and `@deepseek-ai/dsh-sandbox-ssh` providers bind to this service with no configuration of their own. There are no credential fields: authentication stays with the OpenSSH alias.

## The six changes

1. **Capability probe instead of a platform refusal** (`probeClient()`, `probeSshClient()` and `multiplexesClient()` in `src/index.ts`). The shipped constructor throws `SSH runtime requires a POSIX client` on any non-POSIX host. Here startup first runs `ssh -V` with the configured request deadline and no console window, and decides the forwarding mode from the answer:
   - the client exited zero and identified as OpenSSH on a POSIX host → `multiplexed`;
   - the client exited zero but did not identify as OpenSSH, or the host is Windows → `per-stream`;
   - the client did not run (missing binary, non-zero exit without a banner, deadline) → startup rejects with `SSH client 'ssh' is unusable on <platform>: <reason>`, naming the command and the platform, before any helper process exists.

   A connection closed while the probe is in flight reports the shipped `SSH connection closed before startup` instead, so disposal reads the same as before.
2. **Temporary directory from `os.tmpdir()`** (`createTemporaryDirectory()` in `src/local-endpoints.ts`, called from `start()`). `join(tmpdir(), 'dsh-ssh-')` replaces the hard-coded `/tmp/dsh-ssh-`. The directory is allocated only in the multiplexed mode that uses it for the control socket and the stream sockets; `dispose()` removes it under the same guard as before.
3. **Local stream endpoints** (`forwardThroughMaster()` multiplexed, `forwardThroughProcess()` per-stream). The POSIX path is the shipped one: reserve `-O forward` to a socket inside the temporary directory, connect to it, authenticate, and cancel the reservation plus delete the socket when the stream closes. The Windows path reserves an unused loopback port (`reserveLoopbackPort()` in `src/local-endpoints.ts`), starts one `ssh -L 127.0.0.1:<port>:<remote socket>` child for the stream (`StreamChild` in `src/index.ts` owns the child, its spawn failure, its `status()` and its diagnostics), waits for that listener while the client is still authenticating (`connectLoopback()`), and then runs the same connect-and-authenticate tail. A spawn failure is the stream's failure; a child that exits reports its exit code or signal, with a bounded standard-error tail; cancellation, a failed connection or a closed stream terminates the child with SIGTERM and SIGKILL escalation through `StreamChild.stop()`, and `dispose()` joins every child it started (`stopStreamChildren()`).
4. **Connection reuse** (`start()`). The multiplexed mode keeps `-M -S <control> -o ControlPersist=no` and every `-O` command. The per-stream mode passes none of them and issues no control command at all, so it never depends on Win32-OpenSSH multiplexing; the master it starts is an ordinary `ssh -T ... <host> <command>` carrying only the administrative channel. Both spawns share one option table for the options they have in common; the master adds `ClearAllForwardings=yes`, the stream child adds `ExitOnForwardFailure=yes`.
5. **Remote launch command into `target-shell.ts`** (`launchCommand()` in `src/target-shell.ts`, called from `start()`). `launchCommand(launch, helper)` builds the same two command strings the shipped service built inline, including `'\''` quoting and the `NODE_OPTIONS='--disable-sigusr1'` form for an executable, and publishes the configured PTC bootstrap fields. Quoting is POSIX-only because the helper runs on a POSIX host; the module owns `HelperLaunch`, which `src/index.ts` re-exports.
6. **Host-pushed helper provisioning** (`resolveProvision()`, `installProvision()` and `remoteScript()` in `src/index.ts`; `src/provision.ts`; see [Helper provisioning](#helper-provisioning)). With `provision.source` set, startup reads the release archive on the host — its digest and the entry digest its `manifest.json` declares — then probes the remote entry over its own plain `ssh` command and installs the archive only when the entry is missing or differs. Without `provision` nothing changes: `helperHash` stays required and the entry must already be installed.

Two smaller Windows adaptations ride along: the connection, the stream child and the probe command pass `windowsHide: true` so a Windows host does not flash a console window (the `-O` control commands of the multiplexed mode keep the shipped `execFile` call, which that mode is the only reachable caller of), and the per-stream child omits `ClearAllForwardings=yes` — that option also clears command-line forwardings, which would drop the `-L` the child exists for.

## Helper provisioning

`provision.source` is an absolute host-local path to a release archive — the `dist-exe/ssh-helper/dsh-ssh-helper-<version>-linux-x64.tar.gz` that `scripts/build-exe-for-ssh-helper.ts` produces, whose payload directory `dsh-ssh-helper/` holds the entry `dsh-ssh-helper` and a `manifest.json` listing every payload file with its SHA-256. Startup then does this, before the helper process exists, over the same OpenSSH alias the connection uses:

1. **Resolve the expected digest on the host.** The entry digest the archive's `manifest.json` declares becomes the expected digest unless `helperHash` is configured. A configured `helperHash` that differs from it fails startup — the host-local archive and the declared digest must describe the same entry. Archive unreadable, not a ustar tar.gz, or a manifest without the `dsh-ssh-helper` entry all fail with `SSH helper provisioning cannot read <source>: <reason>`.
2. **Probe the remote entry.** `sha256sum <helper>` runs first (it follows a symlink). A digest equal to the expected one finishes here and nothing is transferred; an absent entry (or a dangling link) and a different digest both lead to step 3.
3. **Transfer, verify, extract, link.** The archive bytes go to `<helper parent>/.dsh-provision-<nonce>.tgz` on the remote standard input; the remote recomputes the archive digest and compares it with the host's own `sha256sum` before extracting anything; `tar -xzf` extracts into `<helper parent>/.dsh-provision/.partial-<nonce>`, the staged entry is chmod'ed `0755`, and the payload directory moves into the content-addressed directory `<helper parent>/.dsh-provision/<entry digest>/dsh-ssh-helper/`, so the entry lands at `<helper parent>/.dsh-provision/<entry digest>/dsh-ssh-helper/dsh-ssh-helper`. The entry is then linked: `ln -s` to `<helper>.new.<nonce>` and a same-directory `mv -f` onto `helper`, which is the atomic step (a rename within one directory). Payloads are never deleted by a later attempt, so a running helper's target survives.
4. **Fall through to the shipped handshake.** The helper starts from the configured `helper` path and the hello digest check still decides readiness, so an entry that is neither the archive's nor the configured one still refuses the connection.

Any non-zero remote status stops startup with the exit code and the remote standard-error tail: a host without `sha256sum`, an unreadable installed entry, a failed transfer, an archive digest mismatch (`exit code 98`), a failed extraction or a failed link swap. Every failure also removes this attempt's archive, staging directory and dangling link; a failed attempt leaves any previously installed entry untouched. Each of the three scripts is bounded by `requestTimeoutMs`, so a slow link needs a larger value.

The remote prerequisites are `sha256sum`, `tar`, and a writable parent directory for `helper` (created when absent). Symlinks must be supported on that filesystem, and the configured `helper` is replaced by a symlink into the payload directory. Keep the entry outside the workspace and outside any temporary tree a backend replaces, exactly as the shipped package requires: the payload beside it inherits that placement. Provisioning is limited to `launch.kind: "executable"`, because the release archive is a self-contained executable; a `node-script` launch with `provision` fails at load.

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

The connection keeps every shipped field and adds one optional one; `helperHash` became optional.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Existing OpenSSH host alias, with its user, key and known-host entry |
| `launch` | required | `{ kind: "executable" }` or `{ kind: "node-script", node: "/absolute/node" }`, optionally with `bootstrapPath` + `bootstrapHash` |
| `helper`, `workspace` | required | Absolute remote helper entry and default workspace |
| `helperHash` | required unless `provision.source` is set | Lowercase SHA-256 of the installed helper entry; with `provision` it must equal the entry digest the archive's manifest declares |
| `provision.source` | omitted | Absolute host-local release tar.gz this connection installs when the remote entry is missing or differs; requires `launch.kind: "executable"` |
| `requestTimeoutMs` | `30000` | Probe, connection and administrative-request deadline |
| `maxFrameBytes` | `67108864` | Per-message JSON payload ceiling |
| `maxPending` | `128` | Ordinary outstanding requests |
| `leaseMs` | `30000` | Helper heartbeat lease |

`config.workspace` and the patched `sandbox-policy` `workspaceRoot` name the same remote directory: the first is the helper's default workspace, the second is the write root the sandbox policy grants. The profile patch must set both to the same path.

Without `provision`, the remote host still needs the POSIX helper installed, outside the workspace and outside any replaced temporary tree, exactly as the shipped package documents. With `provision`, the connection installs it there itself when the entry is missing or differs.

## Adaptations the fork needed

1. **Package identity and build.** Name `@banzhe/dsh-ssh-posix`, loader id `ssh-posix`, plain `tsdown` config with `fixedExtension: false` (so `lib/index.js` matches `main`/`types`, as `plugins/web-icons` does). `protocol.ts`, `schemas.ts` and `stream-security.ts` are copied byte for byte.
2. **Dependency sections.** `@deepseek-ai/*` peers are caret ranges matching the DSH release this fork was built against; the copied manifest's `workspace:*` specifiers cannot be published. `@deepseek-ai/dsh-brand` was added to the workspace catalog for that reason. `zod` is a regular dependency (catalog specifier), as in the shipped package and in `plugins/agent-preset-per-workspace`.
3. **Ported specs run the POSIX arrangement anywhere.** `tests/startup-behavior.spec.ts` and `tests/connection-disposal.spec.ts` mock `process.platform` as `linux` (the upstream specs instead skip entirely on Windows), and their `execFile` doubles answer the `-V` probe with a POSIX OpenSSH banner. Control-command assertions count only non-probe calls, through a `control()` helper.
4. **The upstream platform-refusal test is gone.** `startup-behavior.spec.ts` no longer asserts that a `win32` client is rejected; `tests/windows-host.spec.ts` asserts the opposite and covers the probe, both modes, the stream-child failure paths and the reclamation paths.
5. **One disposal assertion changed.** The upstream test expected the temporary directory to be created and removed when disposal lands before startup; the probe now precedes allocation, so that test expects no directory at all. The failure it guards against (a spawned child after disposal, a leaked directory) still fails the test.
6. **Thirteen upstream spec files are not ported.** Eleven of them need the remote helper source this Bundle does not own — `collection.spec.ts`, `helper-boundaries.spec.ts`, `helper-cleanup-join.spec.ts`, `helper-failure-settlement.spec.ts`, `helper-finalization.spec.ts`, `helper-lifecycle.spec.ts`, `helper-processes.spec.ts`, `helper-runtime.spec.ts`, `stream-capability.spec.ts`, `stream-lifetime.spec.ts` and `stream-rebind.spec.ts` import `helper.ts` or `helper-processes.ts` directly, or through the in-process harness in `tests/fixtures/helper.ts`. `inspector-signal.spec.ts` imports neither: it asserts the shipped `sandbox-local` signal hardening, which is not this Bundle's surface. `live.e2e.ts` does import the forked `src/index.ts` but needs a reachable POSIX host with an installed helper, so it stays a real-machine suite.
7. **A copy would cost more than it proves.** Running the eleven helper specs here would need the helper sources vendored into `tests/` or a dependency on the published `@deepseek-ai/dsh-ssh`; either way the assertions would describe code this package does not ship. The eight ported files cover every forked module.

## Test inventory

`pnpm -C plugins/ssh-posix test` runs 10 files and 128 tests:

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
| `tests/provision.spec.ts` | 18 | helper provisioning, below |

The Windows cases: a Windows host starts and spawns instead of refusing; a stream becomes a loopback listener with a `127.0.0.1:<port>:<remote path>` `-L` specification; the per-stream child carries exactly the shipped option set; a refused first attempt is retried until the client's listener exists; a refused listener past the deadline fails with the endpoint named; a child that exited before accepting reports its exit code, and one that was signalled reports its signal; a spawn failure is the stream's failure; a failure carries the client's standard-error tail, of which only the trailing 4 KiB survives; closing the stream kills its child; a child that ignores SIGTERM is killed outright before disposal completes; a live child is joined by disposal rather than abandoned; the temporary directory comes from `os.tmpdir()`; the POSIX master arguments and remote command equal the shipped ones; the target-shell policy reproduces the shipped quoting; an unusable client fails loudly and spawns nothing; a non-multiplexing client falls back to per-stream.

The provisioning cases: a matching installed entry skips the transfer and keeps the connection idempotent; an absent entry and a differing entry each transfer the archive, verify it, extract it and swap the link; a transfer whose digest differs fails with the attempt's files removed and no helper spawned; a non-archive and a manifest without the entry digest each fail before any SSH command; a configured `helperHash` that disagrees with the archive fails at load; `provision` with a `node-script` launch and a configuration with neither digest each fail at load; a host without `sha256sum` and an unreadable installed entry fail with the remote's own text; the same installation succeeds through the per-stream arrangement on a Windows host and through the multiplexed master on a POSIX host; the manifest is read whether the archive lists it before or after the entry. Loading through the plugin surface keeps `provision.source` intact and rejects a source-less `provision` object. Three unit cases pin the remote script text, the derived payload paths and the probe-digest parse.

## Known limitations

- **No Windows remote target.** The helper, the wire schemas (`remotePath` in `src/schemas.ts` requires an absolute POSIX path) and the `linux | darwin` platform field all describe a POSIX target. Connecting to a Windows SSH host is a separate contract: it needs a rewritten helper, a win32 packaging target and a Windows `sshd` to verify against.
- **Win32-OpenSSH is unverified end to end.** No test in this repository runs a real `ssh` client; the per-stream arrangement is proven against mocked transport only. A real POSIX target is required to confirm it, and the shipped `live.e2e` harness reads `DSH_SSH_TEST_CONFIG` for exactly that.
- **The port reservation is advisory.** The loopback port is released before the client binds it; a lost race surfaces as an `ExitOnForwardFailure` error rather than a retry on another port.
- **Stream count is the consumer's decision.** This Bundle sets no ceiling on concurrently forwarded streams; the administrative channel's `maxPending` bounds requests, not channels.
- **Web views still assume the host filesystem.** The shipped SSH documentation says so: replacing the providers does not make workspace views remote-aware. Use a headless profile, or expect the file-oriented UI to describe the local machine while the agent works remotely.
- **The profile layer needs providers a stock installation lacks.** `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh` and `@deepseek-ai/dsh-sandbox-ssh` must resolve in the profile's dependencies.
- **The helper-internal and real-machine suites are not part of this package.** See adaptations 6 and 7.
- **Provisioning is proven against mocked transport only.** No test in this repository pushes a real archive over a real `ssh`; the remote scripts run against scripted children. A real target (with `sha256sum`, `tar` and symlinks) is what confirms them, and only the shipped `live.e2e` harness reaches one.
- **Provisioning trusts the archive it was pointed at.** `provision.source` is a deployment-owned host path, like `helper` and `helperHash`: the digests it checks prove the transfer and the installation are the ones the host read, not that the archive was built by a trusted party. It replaces manual installation, not artifact signing.
- **A stream failure quotes the client's own standard error.** The per-stream path appends a bounded stderr tail to the failure text, which is the useful half of an OpenSSH refusal (`Permission denied (publickey)`, a host-key complaint) and also whatever else the client chose to print — the configured host alias, a `known_hosts` or identity-file path. That text reaches a model as an error message; the shared master keeps standard error suppressed, as the shipped service did.
- **The patched write root is a placeholder.** `sandbox-policy.workspaceRoot` ships as `/home/deploy/project` in this Bundle's patch, standing in for the deployment's remote workspace. Override it together with the connection's `workspace`; a deployment that forgets gets a sandbox rooted at a path that usually does not exist on the SSH host, and nothing fails loudly at load time.

## Release status

This Bundle is in development. Two mechanisms hold it out of the release pipeline: `"private": true` in `plugins/ssh-posix/package.json`, which keeps the release workflow's publish step away from it, and an `ignore` entry for `@banzhe/dsh-ssh-posix` in `.changeset/config.json`, which keeps the version PR from bumping it. The changeset describing the first release stays in the working tree and is deliberately not committed — an unreleased changeset never reaches a version PR.

Cutting the first release is one change: drop `"private": true`, drop the `ignore` entry, and add the changeset. The ordinary version PR then publishes it.

## Credits

Forked from `@deepseek-ai/dsh-ssh` in DeepSeek Harness (MIT © DeepSeek), `my_dev @ 3a01e5a`. License: MIT.
