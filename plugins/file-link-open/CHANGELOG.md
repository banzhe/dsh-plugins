# @banzhe/dsh-file-link-open

## 0.2.4

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.
- 3a9b399: File paths now contribute their entries to the official file context menu instead of adding a second, duplicate set beside it: one group with copy path, copy relative path, and the applications that can open the file. Entries act on the workspace of the Session the click came from rather than the directory of the process serving the menu, and an application probe that fails leaves the entry in place, so the next click retries it.

## 0.2.3

### Patch Changes

- 97414ec: 重构右键菜单为常驻挂载并由内部 state 驱动，消除每次右键重复调用 contextRoot.render 与 Portal 重建的性能开销。

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
