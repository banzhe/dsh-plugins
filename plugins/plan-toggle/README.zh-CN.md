# @banzhe/dsh-plan-toggle

在对话 Composer 里用 `Shift+Tab` 切换 plan 模式。

[English](./README.md)

Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 在对话 Composer 里按 `Shift+Tab`，会像斜杠菜单那样认领 `/plan`。模式在那条命令发出时才改变。
- 关闭态 → 在当前草稿前插入 `/plan `，发送即进入 plan，并可把草稿作为 plan 消息带过去。
- 开启态 → 把草稿替换为 `/plan off`，发送即退出 plan。
- 发送前再按一次 `Shift+Tab` 会撤销这次认领。
- 忽略按键重复与输入法组合态。已打开的触发菜单、当前无会话、或无 `plan` 投影时，快捷键保持原行为。
- 认领被拒绝时，浏览器的反向 Tab 焦点移动仍然生效：只有 Composer 接受之后，手势才会被消费。
- 会出现在快捷键参考（设置 → 快捷键）的 Composer 分组里，并带本地化标签（`切换计划模式` / `Toggle plan mode`）。
- 只读：无法在设置里改键。
- 内置的 plan chip 与 `/plan` 命令保持不变。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-plan-toggle
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-plan-toggle build
dsh plugin --profile web add ./plugins/plan-toggle
```

把 Bundle 加入 `dsh.profile.bundles` 需要重启进程。之后改动源码要重新构建 `lib/` 并刷新 GUI；不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-plan-toggle
```

## 文档

实现说明：[`docs/plugins/plan-toggle.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/plan-toggle.md)。
