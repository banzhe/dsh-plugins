---
"@banzhe/dsh-devcontainer": patch
---

Resolve a `(sbx)` session's shell workdir to the host workspace it names. A sandbox spells a Windows drive directory without the drive colon (`F:\personal\asmr-manager` is `/f/personal/asmr-manager` inside it), and that spelling has no host ancestry for the repository walk to follow, so a command arriving with it resolved to no host directory and the `(sbx)` refusal fired. The shell row now reverses the spelling before asking the registry, and a row mounted without a `cwd` takes the workspace from the directory its workdir names, so `sbx exec` runs against the sandbox of that directory; a container declaration above it still wins.
