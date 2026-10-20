# @banzhe/dsh-file-link-open

右键点击 DSH Web 会话里的任意文件链接，即可用编辑器或文件管理器打开它，或复制其路径。

[English](./README.md)

双半部 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

右键点击会话消息里渲染出的文件链接（文件提及或 markdown 文件链接），会在光标处打开菜单：

- 🚀 **用检测到的编辑器/IDE 打开**——VS Code、Cursor、Sublime Text、JetBrains 全家桶等，各自带真实应用图标。应用检测与启动复用官方 `open-in-app` 解析器（macOS 的 `.app` bundle、Windows 的 `App Paths` 注册表 / 卸载记录 / `%ProgramFiles%` 扫描、Linux 的 PATH 名称与 desktop entry）。
- 📂 **在系统文件管理器中打开所在目录**——Finder（macOS）/ 资源管理器（Windows）/ 桌面文件管理器（Linux），走官方 `POST /open-in-app/open` 路由。
- 📋 **复制相对路径 / 复制绝对路径**——一键完成，纯浏览器侧，始终是裸路径。

相对路径以当前查看会话的工作目录为基准解析。官方左键预览行为不受影响。

- 带行号的 markdown 文件链接——`[source](src/a.ts#L24)` 或区间形式 `#L24-L30`——会在**该行**打开编辑器，菜单会显示 `Line 24` 标题，让目标在启动前就可见。
- 打开文件时**复用已打开的窗口**，而不是新开一个。
- 只有当官方探测**与**本插件自身的解析都确认后，编辑器才会出现在菜单里，因此版本错配绝不会出现「菜单里有、点了 400」的情况。

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
