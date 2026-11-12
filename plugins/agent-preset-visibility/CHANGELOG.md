# @banzhe/dsh-agent-preset-visibility

## 0.2.1

### Patch Changes

- 9ae083b: Every browser half is built by one shared recipe and resolves the shell's module table in full: React, Cordis, Zod, the store engine, the slot registry, the UI primitives, and the dockkit are requested from the page instead of being bundled, and each package additionally declares the client packages whose services it injects. Bundles no longer carry a second copy of React or of the store engine, and the title-model settings no longer carry a bundled copy of the store engine.

## 0.2.0

### Minor Changes

- 87493c0: Add `@banzhe/dsh-agent-preset-visibility`: hide chosen agent presets from every
  web preset picker (new-session chip, session header, Settings roster) while their
  registration, selection and subagent delegation keep working, and choose the
  hidden presets from a Settings page that lists the full roster. The hidden list
  is a volatile settings field, so it lands in the profile patch, survives a
  restart, and applies without one; it ships empty, so an install changes nothing
  until a preset is cleared. This is the package's first release.
