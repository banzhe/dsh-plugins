---
"@banzhe/dsh-session-title-rules": patch
---

Declare `session-title` in `LlmRequestPurposeMap`. A title request then names a purpose that `GenerateOptions` accepts on DSH 0.2.2 and later, where `purpose` is limited to the purposes their producers declare. The declaration is type-only: the emitted JavaScript and the request a title call sends are the same on every 0.2.x release, with `purpose: 'session-title'` forwarded unchanged.
