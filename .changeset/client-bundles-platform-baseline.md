---
"@banzhe/dsh-app-notification": patch
"@banzhe/dsh-agent-preset-visibility": patch
"@banzhe/dsh-devcontainer": patch
"@banzhe/dsh-file-link-open": patch
"@banzhe/dsh-git": patch
"@banzhe/dsh-open-in-select": patch
"@banzhe/dsh-plan-toggle": patch
"@banzhe/dsh-session-attention": patch
"@banzhe/dsh-session-title-rules": patch
"@banzhe/dsh-sidebar-menu-actions": patch
---

Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.
