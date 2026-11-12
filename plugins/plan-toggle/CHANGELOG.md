# @banzhe/dsh-plan-toggle

## 0.2.3

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.

## 0.2.2

### Patch Changes

- 1304f3e: Rewrite every plugin README as features plus installation only, add a Chinese `README.zh-CN.md` beside it, and move the implementation notes to `docs/plugins/<name>.md`.

## 0.2.1

### Patch Changes

- 4d27559: Use caret ranges for `@deepseek-ai/*` peerDependencies instead of exact DSH versions. Plugin versions no longer follow DSH releases.
