---
'@banzhe/dsh-devcontainer': patch
---

Add `hostMounts` to the Host row, so a `(sbx)` session reads the host's global `AGENTS.md` and skills: a created sandbox mounts them read-only beside the workspace. `auto` (the default) mounts `<dshHome>/AGENTS.md`, `<agentsHome>/AGENTS.md`, `<dshHome>/skills`, and `<agentsHome>/skills` when they exist, `off` mounts none, and a list names its own `PATH[:TARGET][:ro]` entries. A source that does not exist is skipped with a warning instead of failing the create, the filesystem fence admits only the mounts the row declares, and the mounts are fixed when the sandbox is created — a path added later needs `sbx rm` and a fresh sandbox.
