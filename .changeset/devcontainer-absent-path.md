---
"@banzhe/dsh-devcontainer": patch
---

Report an absent path the same way inside a Linux container as on a Windows host: `resolve` now keeps the suffix under the nearest existing ancestor when a parent segment is a file, instead of refusing the whole path with `FS_NOT_FOUND`. A file used as a directory fails `realpath` with `ENOTDIR` on POSIX and `ENOENT` on Windows, and the helper treated only the second as absence, so `<repo>/a.ts/child.ts` resolved on a Windows host but was rejected inside the container; `stat`, `lstat`, `listDir`, and every read already reported that entry as absent, and `resolve` now agrees with them. Repository discovery also walks ancestors with the path module that owns the start path's spelling, so a Windows-shaped host path is no longer normalized by `win32` and then split by the platform module, which stopped the walk from finding the declaration above it.
