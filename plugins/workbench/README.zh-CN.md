# @banzhe/dsh-workbench

侧栏工作区浏览区、会话 hero 的工作区选择器，以及列表上方的进行中区，作为一个 Bundle 交付，并**替换**官方 `ui-workspace` 行。

[English](./README.md)

适用于 **web** profile 的 Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle。

## 提供什么

- `sidebar.workspaces` —— 整个浏览区：进行中区、分区标题、搜索、分组/扁平会话行、"显示更多"水位、工作区弹窗，以及会话行的 leading/trailing/hover 座位。
- `conversation.hero.workspace` —— 空白会话 hero 与新会话视图里的选择器。
- `uiWorkspace` 客户端服务、`useWorkspaces` / `useWorkspaceAccess` 根 hooks、`workspace` locale 命名空间，以及导航快捷键（新建会话、会话搜索、添加工作区、重命名、分叉、归档）。
- **进行中** —— 列表上方的一块，包含两个各自可收起的组：**运行中**（自己正在运行、或其下有 subagent 在运行的会话，含置顶）与**未读**（已完成未读的会话，以及没有运行任务的置顶会话）。subagent 会话在两组中都不占行，任意委派深度皆然：被委派的工作只会通过发起它的 lead 会话进入本区。每个会话只出现一次：置顶且运行中的只进运行中，置顶且未读或静止的只进未读。每组标题各自显示本组计数，两组之上没有总标题也没有总数：空组不渲染折叠，两组都为空时整块不渲染。它不持久化任何状态、不发起额外刷新：点击行走工作区所有者的导航（未读标记由那里的 ui-session 清除），唯一的写入是取消置顶。桌面版里同一个模型还驱动 Windows 任务栏脉动：有会话在运行、且没有等待用户或已完成未读的会话时显示不确定进度，否则清除；浏览器中不生效。已停用的 `@banzhe/dsh-session-attention` 面板内容现在在这里。
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
