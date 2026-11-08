---
"@banzhe/dsh-devcontainer": patch
---

Keep a `(sbx)` session's filesystem calls inside its sandbox mount. A Windows host's sandbox mounts the workspace at the drive-letter spelling of the host directory (`/f/personal/repo` for `F:\personal\repo`), while the specification a call was routed through still carried the drive path, so the workspace itself was refused as outside the repository. Routing now asks the runtime where the sandbox mounts the workspace before it attributes a path to a repository (the same probe the first call would run), every spelling of the mount counts as inside — the specification's folder, the drive-letter spelling, and the realpath the container reported — and an absolute path the mount does not hold is refused instead of being re-based onto it, so a sandbox session can no longer reach the container's own `/etc` through a path it named.
