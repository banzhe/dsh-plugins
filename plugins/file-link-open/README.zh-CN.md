# @banzhe/dsh-file-link-open

右键点击 DSH Web 会话里的任意文件链接，即可用编辑器打开它，或复制其相对路径。

[English](./README.md)

双半部 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

右键点击会话消息里渲染出的文件链接（文件提及或 markdown 文件链接），会在光标处打开官方 DSH 上下文菜单，下列条目追加在 DSH 原有的文件条目之后：

- 🚀 **用检测到的编辑器/IDE 打开**——VS Code、Cursor、Sublime Text、JetBrains 全家桶等，各自带真实应用图标。应用检测与启动复用官方 `open-in-app` 解析器（macOS 的 `.app` bundle、Windows 的 `App Paths` 注册表 / 卸载记录 / `%ProgramFiles%` 扫描、Linux 的 PATH 名称与 desktop entry）。
- 📋 **复制相对路径**——一键完成，纯浏览器侧，始终是裸的工作区相对路径。

DSH 自己为同一个文件提供的条目——在侧边栏或浮窗中打开、在文件管理器中显示、用默认应用打开、复制绝对路径——保持不动。本插件只补它们没有覆盖的部分，因此不会出现重复条目。

相对路径以**被点击的那个会话**的工作目录为基准（目录取自菜单打开时的目标），因此并排显示两个不同工作区的窗格会各自解析各自的目录。

- 带行号的 markdown 文件链接——`[source](src/a.ts#L24)` 或区间形式 `#L24-L30`——会在**该行**打开编辑器，菜单会显示 `第 24 行` 标题，让目标在启动前就可见。
- 打开文件时**复用已打开的窗口**，而不是新开一个。
- 只有当官方探测**与**本插件自身的解析都确认后，编辑器才会出现在菜单里，因此版本错配绝不会出现「菜单里有、点了 400」的情况。
- 打开或复制失败由官方菜单自带的失败提示反馈，而不是只写控制台。
- 探测轮次失败后，下一次右键会重新探测，而不是一直退化成只剩复制条目直到页面刷新。
- 需要 markdown 文件链接绑定官方 `file` 上下文菜单目标位的 DSH，即 **DSH `0.2.2-rc.2` 或更高**。更旧的渲染器（含已发布的 `0.2.1-alpha.2` 包）不会把该目标位交给任何贡献，官方菜单会正常打开但不含这些条目。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-file-link-open
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-file-link-open build
dsh plugin --profile web add ./plugins/file-link-open
```

然后重启 `dsh web` 并强制刷新浏览器页面。**host** 半部只在激活时加载一次，因此重新构建需要重启 `dsh web`。**client** 半部从磁盘读取，HMR watcher 运行时刷新页面即可生效。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-file-link-open
```

## 文档

实现说明：[`docs/plugins/file-link-open.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/file-link-open.md)。

## 致谢

本实现衍生自 [cholf5/dsh-plugin-file-actions](https://github.com/cholf5/dsh-plugin-file-actions)（MIT © cholf5），裁剪为文件链接右键打开的相关操作。

## 许可

MIT
