# @banzhe/dsh-picker-browse

页内「选择工作区目录」对话框，头部带盘符按钮行。

[English](./README.md)

面向 **web** profile 的 DSH Web 客户端 Bundle。它替换官方的 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 行，两者只启用其一。

## 功能

- 填充工作区 UI 声明的两个目录流洞（`sidebar.workspaces.directoryFlow`、`conversation.hero.workspace.directoryFlow`），声明晚于本插件激活时同样成立。
- 官方对话框的全部行为：680×500 的 Miller 双栏、面包屑与点击即编辑的路径区、按输入尾段前缀过滤、嵌套的「新建文件夹」对话框、显示隐藏文件开关，以及加载中、内容截断、失败的提示面。
- **盘符按钮行（本 fork 新增）。** 宿主路径是 Windows 路径时，头部为宿主能列出的每个盘符提供一个按钮：对话框打开时并行探测 `C:\` 至 `Z:\`，不存在或不可读的盘静默丢弃，因此不会有按钮指向宿主打不开的目录。点击按钮即跳转到该盘根——与在路径编辑里手打 `F:\` 回车落到同一处；当前层级所在的盘会高亮。这一行换行而不横向滚动，盘符再多也不会把路径栏挤出卡片。
- POSIX 宿主不会看到这一行：探测以宿主自己在 home 路径里带的路径分隔符为条件，远程 Linux／macOS 宿主不为此付出任何探测开销。
- 对话框文案（含盘符行的分组标签与每个按钮的无障碍名称）随 Bundle 自带的 `directory-browser` 语言命名空间发布，八种语言齐全。

## 安装

### 从 npm

```sh
dsh plugin --profile web add @banzhe/dsh-picker-browse
```

### 从本地检出

```sh
pnpm install
pnpm --filter @banzhe/dsh-picker-browse build
dsh plugin --profile web add ./plugins/picker-browse
```

两种方式都要求宿主后端行 `@deepseek-ai/dsh-host-directory-picker-browse` 保持启用，并停用官方的 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 行；后一步由 Bundle 自带的补丁完成（profile 以 bundle 方式挂载本包时）。改完需重启 `dsh web`；之后改源码要重新构建 `lib/` 并刷新界面，不要指望 HMR。

移除：

```sh
dsh plugin --profile web remove @banzhe/dsh-picker-browse
```

## 文档

实现说明、本 fork 的适配清单与已知限制：[`docs/plugins/picker-browse.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/picker-browse.md)。

## 致谢

fork 自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh-client-ui-directory-picker-browse`（MIT © DeepSeek）。对话框本身、它的行为、样式、测试与文案都来自那个包；盘符按钮行与实现说明里列出的适配是本 Bundle 的改动。

## 许可

MIT
