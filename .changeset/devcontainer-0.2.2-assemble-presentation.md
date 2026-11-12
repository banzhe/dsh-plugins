---
"@banzhe/dsh-devcontainer": patch
---

Works with DSH 0.2.2-rc.2, whose prompt assembly hands listeners the presentation half of the assembly (sections, contexts, variables) instead of the complete assembly with tool declarations. The container context is written into the working-directory contribution exactly as before; only the accepted parameter type is the wider one both halves share. The `@deepseek-ai/dsh-system-prompt` peer now states the version this shape belongs to.
