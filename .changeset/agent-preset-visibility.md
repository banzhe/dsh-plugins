---
"@banzhe/dsh-agent-preset-visibility": minor
---

Add `@banzhe/dsh-agent-preset-visibility`: hide chosen agent presets from every
web preset picker (new-session chip, session header, Settings roster) while their
registration, selection and subagent delegation keep working, and choose the
hidden presets from a Settings page that lists the full roster. The hidden list
is a volatile settings field, so it lands in the profile patch, survives a
restart, and applies without one; it ships empty, so an install changes nothing
until a preset is cleared. This is the package's first release.
