---
"@banzhe/dsh-devcontainer": patch
---

Attribute a `(sbx)` session's filesystem calls to the workspace their path names. One row serves every session on the host, so its configured `cwd` is the directory DSH itself started in — under `dsh web`, the installed Bundle — while a `(sbx)` session names directories in its sandbox's spelling (`/f/personal/repo` for `F:\personal\repo`), which has no host ancestry for the repository walk to follow. The host directory is now recovered before routing gives up: from the mounts `sbx ls` reported, deepest first, which names the workspace root whether or not the repository declares a container, and from the drive convention only when a repository really declares a container above the directory it spells. A path outside every mount is still refused on the host, and `/f/…` cannot claim a host directory no repository declares.
