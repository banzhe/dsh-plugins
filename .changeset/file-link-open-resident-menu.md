---
"@banzhe/dsh-file-link-open": patch
---

重构右键菜单为常驻挂载并由内部 state 驱动，消除每次右键重复调用 contextRoot.render 与 Portal 重建的性能开销。
