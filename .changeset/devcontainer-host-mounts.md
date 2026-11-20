---
'@banzhe/dsh-devcontainer': patch
---

Mount the host's global agent configuration in Dev Containers too. `hostMounts` now feeds one plan into both tracks, so a created Dev Container takes `<dshHome>/AGENTS.md`, `<agentsHome>/AGENTS.md`, and the two `skills` trees as `--mount` binds beside the workspace, exactly as a Docker Sandbox takes them at create. The Dev Container CLI's `--mount` form has no read-only field, so those binds are writable from inside the container and the filesystem fence keeps them read-only instead: a write, edit, patch, delete, or move of a mounted host path is refused with `FS_PERMISSION_DENIED`, and a mounted skills tree is readable only as `<skill>/SKILL.md` and `<skill>/references/**`. A container that was not created with these mounts answers a read of a mount path with `FS_NOT_FOUND` until it is recreated.
