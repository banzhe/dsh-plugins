# dsh-plugins

个人使用的 DeepSeek Harness 插件集。`plugins/` 下的每个目录都是一个可独立安装的 [Bundle](./CONTEXT.md)。

英文版见 [README.md](./README.md)。

## 目录结构

```
plugins/<name>/                         # 一个 Bundle：@banzhe/dsh-<name>
.agents/skills/add-dsh-plugin/          # 如何新增插件
docs/plugins/<name>.md                  # 各插件的实现说明（英文）
CONTEXT.md                              # 术语表
```

## 插件

| 插件 | 功能 |
| --- | --- |
| `agent-preset-fallback` | 存储或请求的 agent preset 已不存在时，回退到部署默认 preset，而不是让会话创建失败 |
| `agent-preset-per-workspace` | 记住每个工作区里手动选过的 agent preset，该工作区的下一个会话沿用 |
| `app-notification` | 把「已完成未读」会话数投影到已安装 PWA 的图标角标，并在会话完成时发一条系统通知 |
| `file-link-open` | 右键会话消息里的文件链接：用编辑器/IDE 打开、打开所在目录、复制相对/绝对路径 |
| `git` | 右侧栏 Git 面板：列出当前会话工作区的改动文件，并用填写的消息提交 |
| `plan-toggle` | 在 Composer 里用 `Shift+Tab` 切换 plan 模式 |
| `session-attention` | `shell.overlay` 面板：列出运行中与已完成未读的会话，点击跳转 |
| `session-title-rules` | 规则化的会话标题提供方（`emoji 主题`），替代内置的首条提示词提供方 |
| `sidebar-menu-actions` | 侧栏行菜单扩展：在工作区「...」菜单里插入「在 VS Code 中打开」 |
| `web-icons` | 由 Bundle 自带快照提供 Web 图标集（favicon、PWA manifest 图标等） |

## 新增插件

按项目技能 [add-dsh-plugin](./.agents/skills/add-dsh-plugin/SKILL.md) 操作，然后：

```sh
pnpm install
pnpm --filter @banzhe/dsh-<name> build
```

## 安装到 web Profile

在仓库根目录执行，且 `lib/` 已存在：

```sh
dsh plugin --profile web add ./plugins/<name>
```

该命令把当前 checkout 以 `link:` 方式链入 `$DSH_HOME/profiles/web`，并把 `@banzhe/dsh-<name>` 追加到 `dsh.profile.bundles`。改动源码后需要重新构建；不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-<name>
```

## Lint

使用 [oxlint](https://oxc.rs) 搭配 `oxlint-tsgolint`（类型感知），在根目录 `.oxlintrc.json` 统一配置，覆盖每个 Bundle 与 `devkit`：

```sh
pnpm lint
pnpm lint:fix
```

其中 correctness 与类型感知规则块与上游 DeepSeek Harness 自用的规则一致，因此一个 Bundle 读起来就像它所接入的那些包。上游的 `@stylistic` 与 `sonarjs` 规则块被有意去掉：格式化属于格式化工具，不属于 linter。两个工具都在 `pnpm-workspace.yaml` 的 catalog 中精确锁版本。

## Git hooks

`pnpm install` 会把 `core.hooksPath` 指向 `.githooks/`。如果 clone 时已有 `node_modules`，手动执行一次：

```sh
pnpm hooks:install
```

| Hook | 执行内容 |
| --- | --- |
| `pre-commit` | `pnpm typecheck` |
| `pre-push` | `pnpm lint`、`pnpm typecheck`、`pnpm test` |

`pre-push` 与 CI 的 `verify` job 是同一道关卡，后者决定 push 到 `master` 后是否发布。用 `git commit --no-verify` 或 `git push --no-verify` 跳过。

## 环境要求

- Node `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- 支持 `dsh plugin` 的 DSH CLI
