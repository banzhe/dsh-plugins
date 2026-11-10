---
'@banzhe/dsh-devcontainer': patch
---

README 补正「沙箱会话读取宿主机全局技能」的配置说明：需要同时设置 `DSH_BUNDLED_SKILL_DIR` 与 `DSH_AGENTS_HOME`，缺一不可。两个变量都只在宿主进程启动时读取，设置后要重启 DSH，才会对之后启动的会话生效。
