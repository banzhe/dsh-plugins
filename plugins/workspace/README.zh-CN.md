# @banzhe/dsh-workspace

侧栏工作区浏览区、会话 hero 的工作区选择器，以及列表上方的关注区，作为一个 Bundle 交付，并**替换**官方 `ui-workspace` 行。

[English](./README.md)

适用于 **web** profile 的 Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle。

## 提供什么

- `sidebar.workspaces` —— 整个浏览区：关注区、分区标题、搜索、分组/扁平会话行、"显示更多"水位、工作区弹窗，以及会话行的 leading/trailing/hover 座位。
- `conversation.hero.workspace` —— 空白会话 hero 与新会话视图里的选择器。
- `uiWorkspace` 客户端服务、`useWorkspaces` / `useWorkspaceAccess` 根 hooks、`workspace` locale 命名空间，以及导航快捷键（新建会话、会话搜索、添加工作区、重命名、分叉、归档）。
- **关注区** —— 列表上方可收起的一块，列出置顶会话、运行中的工作与已完成未读的会话，由会话列表、会话状态与工作区快照折叠而成。它不持久化任何状态、不发起额外刷新：点击行走工作区所有者的导航（未读标记由那里的 ui-session 清除），唯一的写入是取消置顶。已停用的 `@banzhe/dsh-session-attention` 面板内容现在在这里。
- 自带的 `cordis.patch.yml` 会禁用官方 `ui-workspace` 行并以 `workspace-personal` 插入本 Bundle。这些槽位与 `uiWorkspace` 服务只能有一个所有者，因此两行永不共存。

行为是 DSH `0.2.2-rc.2` 官方插件的分叉；`ui-schedule`、`ui-open-in-app`、目录选择器、`ui-context-menu` 以及本仓库其它 Bundle 仍通过相同的槽位声明继续贡献。

## 安装

npm：

```sh
dsh plugin --profile web add @banzhe/dsh-workspace
```

本地 checkout（替换官方行靠本 Bundle 的 `dsh.bundle` patch）：

```sh
pnpm install
pnpm --filter @banzhe/dsh-workspace build
dsh plugin --profile web add link:$(pwd)/plugins/workspace
```

移除：

```sh
dsh plugin --profile web remove @banzhe/dsh-workspace
```

改动源码后需重新构建并重启 `dsh web`：profile 的客户端模块从 `lib/` 读取，且没有客户端 HMR 监视该目录。

## 致谢

工作区浏览区与选择器分叉自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh-client-ui-workspace`（`packages/client/ui-workspace`），MIT，版权归 DeepSeek。

关注模型改编自本仓库的 `plugins/session-attention`（MIT）。

## 许可

MIT
