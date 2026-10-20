# @banzhe/dsh-web-icons

由本 Bundle 自带的快照提供 Web 启动图标集——favicon、PWA manifest、maskable 与 touch 图标——而不再依赖运行中的 harness 恰好装了哪个版本的 `@deepseek-ai/dsh-web-frontend` 里的那份副本。

[English](./README.md)

Host 侧 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，面向 **web** 与 **desktop** profile。

## 功能

- 插件激活时注册八条 `webServer` **exact** 路由：

  | 路径 | 资源 |
  |---|---|
  | `/favicon.ico` | `favicon.ico` |
  | `/favicon-dark.svg` | `favicon-dark.svg` |
  | `/icon-192.png` | `icon-192.png` |
  | `/icon-512.png` | `icon-512.png` |
  | `/icon-maskable-192.png` | `icon-maskable-192.png` |
  | `/icon-maskable-512.png` | `icon-maskable-512.png` |
  | `/apple-touch-icon.png` | `apple-touch-icon.png` |
  | `/manifest.webmanifest` | `manifest.webmanifest` |

- exact 路由先于「服务构建后 Web 目录」的兜底座位匹配，因此这些响应是替换 dist 里的副本，而不是与之竞争。
- 响应 `GET` 与 `HEAD`；其他方法返回 `405` 并带 `allow: GET, HEAD`。
- 响应带 `cache-control: no-cache` 以及基于文件大小与 mtime 的弱校验器，因此浏览器每次导航是重新校验，而不是重复下载数百 KB。
- 有意**不**接管 `favicon.svg`：DSH 源码已弃用该标识，其构建测试要求 dist 不携带它。
- 运行时冲突按设计是显式的——若某个组合已经注册了这些 exact 路径之一，激活会以 `webserver: duplicate exact route "<path>"` 失败。
- 卸载后，Host 重启即回落到 dist 里的副本。

### 不适用的范围

- **桌面应用窗口。** shell 会在请求到达 Host 之前，就为它自己的 `dsh-app://app/` 窗口响应这八个路径中的七个。`/favicon-dark.svg` 是例外。本 Bundle 面向的是浏览器源（`DSH_WEB_URL`）。
- **页面之外的一切。** 可执行文件、任务栏、托盘、安装器、macOS Dock 与「关于」图标都是桌面包的构建期产物，插件无法触及。
- **已安装的 PWA 快捷方式。** 其图标由操作系统缓存，需重装快捷方式才能更新。
- **应用内侧栏品牌标识。** 那是 UI 插槽的占用者，不是 Web 图标。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-web-icons
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-web-icons build
dsh plugin --profile web add ./plugins/web-icons
```

`link:` 会让安装的包始终指向本 checkout，因此改动源码后只需重新构建。路由注册发生在激活时：在 `live` patch profile 上，新安装的 Bundle 无需重启即可到达 Host；而重新构建后的 `lib/` 则需要重启。

**`desktop` profile 是保留的**：`PATH` 上普通的 `dsh` 会以 *"profile "desktop" is managed exclusively by the Electron application"* 拒绝。桌面版自带允许的入口——在 Windows 上是 `<install>\resources\runtime\cli\bin\dsh.cmd`：

```powershell
& '<install>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'link:D:/path/to/dsh-plugins/plugins/web-icons'
```

另一种做法是手动把依赖与 `dsh.profile.bundles` 条目加进 `$DSH_HOME/profiles/desktop/package.json`，再在该目录执行 `pnpm install`。两个 profile 不共享 bundle 列表。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-web-icons
```

## 文档

实现说明：[`docs/plugins/web-icons.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/web-icons.md)。
