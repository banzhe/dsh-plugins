# @banzhe/dsh-git

Web Client Git panel in the right sidebar. The Client registers one page tab (`kind: git`) with a guide entry. The panel lists the current session workspace's changed files as a folder tree and commits them with the message typed into the field. It does not open a file's diff. The Host serves `GET /api/git/status` and `POST /api/git/commit`, and only for a workspace the profile has registered.

Meant for the `web` Profile.

## Install

```sh
dsh plugin --profile web add ./plugins/git
```

Then restart `dsh web`. The Client half hot-reloads when a watcher rewrites `lib/client.js`. Host changes still need a restart. Rebuild `lib/` after source changes.
