# @banzhe/dsh-workbench

侧栏工作区浏览区、会话 hero 的工作区选择器，以及列表上方的可折叠浏览组，作为一个 Bundle 交付，并**替换**官方 `ui-workspace` 行。

[English](./README.md)

适用于 **web** profile 的 Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle。

## 提供什么

- `sidebar.workspaces` —— 整个浏览区：未读/置顶/运行中三个折叠组、分区标题、搜索、作为第四个折叠组的分组/扁平会话树、"显示更多"水位、工作区弹窗，以及会话行的 leading/trailing/hover 座位。
- `conversation.hero.workspace` —— 空白会话 hero 与新会话视图里的选择器。
- `uiWorkspace` 客户端服务、`useWorkspaces` / `useWorkspaceAccess` 根 hooks、`workspace` locale 命名空间，以及导航快捷键（新建会话、会话搜索、添加工作区、重命名、分叉、归档）。
- **浏览折叠组** —— 列表分为四个各自可收起的组：**未读**（已完成未读的会话，置顶与否都算）、**置顶**（无实时工作、也无未读提醒的置顶会话）、**运行中**（自己正在运行或其下有 subagent 正在运行的会话，置顶与否都算），以及浏览列表本身——**全部工作区**，单列表视图下为**全部会话**——恒在最后，默认展开，收起时不丢失"显示更多"水位、分组展开状态与滚动位置。状态优先、置顶随后：置顶会话在运行时进运行中组，完成未读时进未读组，两者都不是时才回置顶组，置顶不会掩盖待看的工作；行上的状态点仍显示真实状态：运行中、已完成未读或等待用户。subagent 会话在任何委派深度都不占行：被委派的工作只会通过发起它的 lead 会话进入本区，由那一行显示运行点。快捷组里的行就是浏览列表自己的会话行——相同的状态点、互斥的悬浮卡、行菜单、悬浮操作、置顶标记、重命名与相对时间，拖拽排序仍只属于工作区树。快捷组里的每一行还在标题下方单独一行、以次级样式显示该会话所属工作区名，因为一个快捷组混合了所有工作区的会话；浏览列表自己的行仍保持单行。每个快捷组标题显示本组计数，四组之上没有总标题也没有总数：运行中与未读的组头即使为 0 也照常渲染，置顶为空时整组不渲染，浏览列表的折叠恒渲染。它不持久化任何状态、不发起额外刷新：点击行走工作区所有者的导航（未读标记由那里的 ui-session 清除），行内操作就是树用的同一批槽位条目。桌面版里同一个模型还驱动 Windows 任务栏脉动：有会话在运行、且没有等待用户或已完成未读的会话时显示不确定进度，否则清除，置顶会话静止不构成新通知；浏览器中不生效。已停用的 `@banzhe/dsh-session-attention` 面板内容现在在这里。
- 自带的 `cordis.patch.yml` 会禁用官方 `ui-workspace` 行并以 `workbench-personal` 插入本 Bundle。这些槽位与 `uiWorkspace` 服务只能有一个所有者，因此两行永不共存。

行为是 DSH `0.2.2-rc.2` 官方插件的分叉；`ui-schedule`、`ui-open-in-app`、目录选择器、`ui-context-menu` 以及本仓库其它 Bundle 仍通过相同的槽位声明继续贡献。

## 安装

npm：

```sh
dsh plugin --profile web add @banzhe/dsh-workbench
```

本地 checkout（替换官方行靠本 Bundle 的 `dsh.bundle` patch）：

```sh
pnpm install
pnpm --filter @banzhe/dsh-workbench build
dsh plugin --profile web add link:$(pwd)/plugins/workbench
```

移除：

```sh
dsh plugin --profile web remove @banzhe/dsh-workbench
```

改动源码后需重新构建并重启 `dsh web`：profile 的客户端模块从 `lib/` 读取，且没有客户端 HMR 监视该目录。

## 致谢

工作区浏览区与选择器分叉自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh-client-ui-workspace`（`packages/client/ui-workspace`），MIT，版权归 DeepSeek。

进行中模型改编自本仓库曾维护、现已退役的 `session-attention` Bundle（MIT）；最后的源码见 git 历史。

## 许可

MIT
