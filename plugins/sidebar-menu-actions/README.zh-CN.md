# @banzhe/dsh-sidebar-menu-actions

侧栏行菜单扩展：复制工作区路径、在 VS Code 或系统文件浏览器中打开工作区。

[English](./README.md)

Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 往工作区「...」菜单里插入 **在 VS Code 中打开**（`Open in VS Code`）、**在文件浏览器中打开**（`Open in File Browser`）与 **复制工作区路径**（`Copy workspace path`），位置在重命名与危险删除行之间。
- **复制工作区路径** 把工作区的绝对路径写入剪贴板，并弹出一条 toast。
- **在 VS Code 中打开** 会 POST open-in-app 的 Host 路由（`{app:'vscode', path:<工作区目录>}`）；只有在 `GET open-in-app/apps` 解析出 `vscode`（由 `dsh-web-app` bundle 提供）之后才会插入该行，否则只少这一行，并在控制台输出一行说明原因。
- **在文件浏览器中打开** 仅在 Windows 上出现：它用 `{app:'explorer', path:<工作区目录>}` POST 同一条路由，而官方目录只在 win32 上声明 `explorer`，因此该行只会在 Windows Host 出现。它走系统的「打开」动词，也就是说会使用你配置的默认文件浏览器，而不是写死 `explorer.exe`。
- 每一行都走 Menu 原语的 Escape 路径关闭菜单，焦点回归与官方菜单项一致。
- 被取消的按压留下的过期挂载状态，绝不会泄漏到某个会话行的菜单上。
- 失败时会在菜单关闭后弹出 toast，显示 HTTP 状态或错误信息。
- 文案与提示跟随应用语言（`menu-actions` 命名空间，zh/en）。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-sidebar-menu-actions
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-sidebar-menu-actions build
dsh plugin --profile web add ./plugins/sidebar-menu-actions
```

需要重启 `dsh web`。之后改动源码要重新构建 `lib/` 并刷新 GUI；不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-sidebar-menu-actions
```

## 文档

实现说明：[`docs/plugins/sidebar-menu-actions.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/sidebar-menu-actions.md)。
