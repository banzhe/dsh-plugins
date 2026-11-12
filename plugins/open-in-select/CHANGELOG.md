# @banzhe/dsh-open-in-select

## 0.2.0

### Minor Changes

- 474668f: Add `@banzhe/dsh-open-in-select`: an icon-only control in the Session header that opens the Session's workspace directory in a local application. Clicking it opens the remembered application, the chevron lists the applications the host offers, and the last choice is remembered. This is the package's first release.

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.
