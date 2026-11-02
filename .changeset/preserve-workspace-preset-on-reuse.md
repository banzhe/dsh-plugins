---
"@banzhe/dsh-agent-preset-per-workspace": patch
---

Supply the workspace's remembered preset to `sessionController.create` when `request.agentPreset` is omitted so reusing a blank session (`reuseLive` / `reuseSetup`) does not reset the session and stored workspace binding back to the global default.
