# @banzhe/dsh-open-in-select

在会话面板右上角用一个紧凑控件，把会话工作区目录在本地应用中打开。

[English](./README.md)

Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 会话面板右上角工具栏（`conversation.session.header.utilities`，order `-10`）最前面有一个紧凑的「用…打开」控件。
- 左侧只显示当前应用的图标，点击即用该应用打开会话目录，不弹菜单；应用名放在按钮的 tooltip 与无障碍名称里，悬停或读屏都能拿到，没有信息丢失。
- 右侧 chevron 列出 Host 解析出的全部应用；选中一项即用该应用打开，并把它记为默认。默认项会在刷新后保留；没有记忆时取 Host 顺序里的第一项。
- 只有一个可用应用时不显示 chevron；没有可用应用（或连不上 `open-in-app` Host）时整个控件不渲染，而不是渲染一个坏掉的控件。
- 打开请求进行中会把控件标记为不可用并丢弃后续按压：指针与 hover 反馈保持不变，不做成"死按钮"，一次手势只产生一次打开请求。
- 打开被拒绝或连不上 Host 时，弹出一条说明失败原因的 toast；区分的状态码见实现说明。
- 应用显示名来自本 Bundle 自己的 id→名称表，不认识的 id 原样显示而不是从列表消失；图标从 Host 的图标路由加载，失败时回退为同尺寸字形。文案跟随应用语言（`open-in-select` 命名空间，zh/en）。
- Host 的应用列表每页只读取一次；记住的应用保存在 local storage 中，刷新后仍在。存储不可用时只退化为内存态。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-open-in-select
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-open-in-select build
dsh plugin --profile web add ./plugins/open-in-select
```

需要重启 `dsh web`。之后改动源码要重新构建 `lib/` 并刷新 GUI；不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-open-in-select
```

## 文档

实现说明：[`docs/plugins/open-in-select.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/open-in-select.md)。

## 致谢

控件的形态与打开行为来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `ui-open-in-app` client 包（MIT © DeepSeek），按 Host 的 `open-in-app` 路由重写，且不 import 该包。

## 许可

MIT
