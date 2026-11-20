# @banzhe/dsh-ssh-posix

The shipped OpenSSH connection service, forked so a **Windows** local host can drive a **POSIX** remote host.

[中文版](./README.zh-CN.md)

A Host-side [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle. It provides the `ssh` service (`ctx.ssh`) and a remote-only profile layer, so it belongs in a profile dedicated to remote work rather than in the profile you use for local files.

## Status: in development

Not released yet. The package is marked `private` and listed in this repository's changesets `ignore` array, so neither the version PR nor the publish step touches it; install it from a local checkout as described below. Cutting the first release means dropping the `private` flag, dropping the `ignore` entry, and committing a changeset in one change.

## Features

- **The connection service the shipped SSH providers consume.** `ctx.ssh` is the same service the shipped `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh` and `@deepseek-ai/dsh-sandbox-ssh` providers bind to: one OpenSSH alias carries the private administrative channel, and every program stream is a separately authenticated TLS-PSK channel keyed from that channel. The remote side is the shipped, digest-verified POSIX helper; this Bundle does not fork the helper.
- **A Windows local host starts.** The shipped connection refuses a non-POSIX client at construction. This fork replaces that refusal with a probe of the local OpenSSH client: a missing or unusable `ssh` fails at startup with the platform, the command and the client's own answer, and a working client lets the connection pick its forwarding arrangement — the choice is not reported to anyone.
- **Two forwarding arrangements, chosen by the probe.** On a POSIX host with an OpenSSH client the connection keeps the shipped arrangement: one OpenSSH master multiplexes the administrative channel and `-O forward`-managed Unix sockets. Every other host — Windows always, and a POSIX host whose client did not identify as OpenSSH — gives each stream its own long-lived `ssh -L` child bound to a loopback port, because Win32-OpenSSH multiplexing and Unix-socket forwarding are unverified.
- **Temporary files under the platform's temporary directory** instead of `/tmp`, so the control socket and forwarding sockets land where the host keeps temporary files.
- **A remote-only profile layer.** The Bundle's patch replaces the local provider rows with the three SSH provider rows and turns on the POSIX shell tool: after it loads, files, processes and the sandbox all address the SSH host. Load it in a dedicated profile — it is not additive. The Web UI is the exception: workspace views still assume the local filesystem, so replacing the providers does not make them remote-aware.
- **Helper provisioning from the host.** Setting `provision.source` to a release archive lets this connection install the helper itself: it reads the entry digest the archive's manifest declares, probes the remote entry with `sha256sum` over its own SSH command, and — only when that entry is missing or differs — pushes the archive, has the remote host verify the transferred bytes, extracts them into a digest-named directory beside the entry, and swaps a symlink onto the configured path atomically. A matching entry transfers nothing. Without `provision` nothing changes: the helper must already be installed and `helperHash` must be declared.
- **Remote target commands quoted for the shell that runs them.** The helper launch command, including its `--disable-sigusr1` protection and PTC bootstrap, is built by a target-shell policy; the POSIX command is byte-identical to the shipped one.

## Install

This Bundle needs the three SSH providers to resolve in the profile: `@deepseek-ai/dsh-fs-ssh`, `@deepseek-ai/dsh-subprocess-ssh`, `@deepseek-ai/dsh-sandbox-ssh`. A stock DSH installation does not ship them; a profile that composes them (or a source checkout that provides them) is required.

### From npm

```sh
dsh plugin --profile <name> add @banzhe/dsh-ssh-posix
```

### From a local checkout

```sh
pnpm install
pnpm --filter @banzhe/dsh-ssh-posix build
dsh plugin --profile <name> add ./plugins/ssh-posix
```

Either route needs the connection's own configuration: the `host` alias (with its existing user, key and known-host entries), `launch`, `helper`, `workspace`, and the helper digest — `helperHash`, or `provision.source` to let the connection install and derive it. The profile's own patch supplies it, and names the remote workspace twice — once for the connection, once for the write root the Bundle's patch leaves as a placeholder:

```yaml
- id: ssh-posix
  config:
    host: my-posix-host
    launch: { kind: executable }
    helper: /home/deploy/dsh-ssh-helper
    helperHash: <lowercase sha256 of that file>
    workspace: /home/deploy/project

- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: /home/deploy/project
```

To install the helper from a release archive instead of declaring a digest, replace `helperHash` with `provision.source` (an absolute host path to the archive); a declared `helperHash` must then equal the entry digest the archive's manifest lists, or the profile fails to load. Provisioning needs `sha256sum`, `tar` and symlinks on the remote host, plus a writable parent directory for `helper`, and only pairs with `launch: { kind: executable }`.

`config.workspace` and `workspaceRoot` must stay equal: the first is the helper's default workspace, the second is the write root the sandbox policy grants. See the implementation notes for the field list and for what the remote host must have installed. Requires a restart of the profile; rebuild `lib/` after later source changes.

Remove with:

```sh
dsh plugin --profile <name> remove @banzhe/dsh-ssh-posix
```

## Docs

Fork surface, the five changes, forwarding-mode rules, test inventory and known limitations: [`docs/plugins/ssh-posix.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/ssh-posix.md).

## Credits

Forked from `@deepseek-ai/dsh-ssh` in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT © DeepSeek), `my_dev @ 3a01e5a`. The connection lifecycle, protocol, validation schemas, stream authentication, remote helper and every ported spec are that package's work; the host-capability probe, the per-stream forwarding arrangement, the temporary-directory policy and the target-shell policy are this Bundle's.

## License

MIT
