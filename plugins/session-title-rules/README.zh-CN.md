# @banzhe/dsh-session-title-rules

基于规则的会话标题提供方：从对话内容生成 `emoji 主题`，替代内置首条提示词提供方的自由格式标题。

[English](./README.md)

双半部 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 替代内置的首条提示词标题提供方。标题服务只有一个提供方位，因此本 Bundle 安装期间内置行会被禁用；移除 Bundle 后即恢复。
- 格式：`emoji 主题`，例如 `🔬 会话标题插件接缝`。
- emoji 是封闭集合——✨ 功能 / 🎨 设计 / 🐛 修复 / ⚡ 优化 / 🚀 发布 / 🔍 探索 / 📝 文档 / 🔬 研究——代表整个类型段。
- `主题` 从真实消息中提炼，不重复项目名，且足够短以适应侧栏（6–14 个中文字符，≤ 8 个英文单词）。
- 主题语言跟随对话；中英混杂时用中文。
- 输入容错不做映射：`⚡️ 主题`、`🐛主题`、`🐛｜主题` 都会规范化为 `emoji 主题`。以其他字形开头的回答会被拒绝，而不是被翻译。
- 消息无法识别主题时，模型回答 `UNCHANGED`；服务给出警告，保留当前标题而不猜测。
- `/title-refresh` 按需从会话的完整对话重新推导标题，因此老会话无需新建即可重命名。它不接受参数。
- 标题模型是设置项而非改代码：**设置 → 插件 → 本插件那一行 → 配置**（或 YAML 里同一处 `config`）可固定 `provider` + `model`，并可选 `reasoningEffort`。三个字段都可选，且无需重启 `dsh web` 即可对**下一个**标题生效。
- `provider` 与 `model` 必须同时设置；只给一半会被拒绝，而不会静默回退到会话模型。两者都不设时，路由跟随会话自身记录的 route。
- 默认节奏下子代理与 fork 子会话不会生成标题：`first-prompt` 只为顶层会话排程，fork 子会话继承父会话标题。
- 设置页的下拉框列出实时 adapter 目录，且只提供所选模型声明支持的 reasoning 档位，因此无法从 UI 固定一个不可调用的路由。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-title-rules
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-title-rules build
dsh plugin --profile web add ./plugins/session-title-rules
```

把 Bundle 加入 `dsh.profile.bundles` 需要重启 `dsh web`。重启后创建的会话由本提供方生成标题。已有标题的会话会保留原标题——不会有任何自动重命名——直到你执行 `/title-refresh`。之后改动源码要重新构建 `lib/`。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-session-title-rules
```

## 文档

实现说明：[`docs/plugins/session-title-rules.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-title-rules.md)。
