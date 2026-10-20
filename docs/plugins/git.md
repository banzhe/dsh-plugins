# git — implementation notes

Moved out of the plugin's README, which now covers only features and installation.

## Shape

The Client registers one page tab (`kind: git`) with a guide entry. The panel
lists the current session workspace's changed files as a folder tree and commits
them with the message typed into the field. It does not open a file's diff.

## Host routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/git/status` | `GET` | The workspace's changed files, as a folder tree |
| `/api/git/commit` | `POST` | Commit the workspace with the supplied message |
| `/api/git/message` | `POST` | Draft a commit message from the staged change context with the session's model |

Every route serves only a workspace the profile has registered: the requested
`cwd` must be absolute and must resolve through `ctx.workspaceRegistry.resolveByPath`.
A missing path and an unregistered directory are the same `404`.

`/api/git/message` picks its route from the session's own selection (`pending`
first, then `lastUsed`) and falls back to the first advertised model of the first
registered provider. A missing provider fails with a `409`, before any diff is
read.
