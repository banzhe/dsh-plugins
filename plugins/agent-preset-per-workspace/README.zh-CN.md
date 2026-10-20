# @banzhe/dsh-agent-preset-per-workspace

记住你在每个工作区里手动选过的 agent preset，该工作区的下一个会话就用它来组合。记忆以 workspace id 为键；preset 已不存在时回退到全局默认。

[English](./README.md)

仅 Host 侧的 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** 与 **desktop** profile（两者组合的是同一个 `dsh-base` + `dsh-web-app` host，因此在任一上都无需 client 半部）。

## 功能

- 在工作区的空白会话上选一个 preset，该工作区就会记住它。
- 该工作区里新建的下一个会话会在首轮之前组合好记住的 preset——chip、工具集与提示词三者一致。
- 你从未选过 preset 的工作区不受影响：仍然使用全局默认。
- 记住的 preset 被删除或禁用后，下一个会话仍会以全局默认正常启动，会话创建不会失败。
- 之后换选别的 preset，工作区跟随最新选择。
- 已有组合的会话一律不动：**resume**、`/clear`、compaction、**fork** 以及所有 **subagent** 都保持其日志或父会话给它们的组合。
- 设置里的「设为新任务默认」同样算一次手动选择，当前工作区会绑定它。
- 没有 UI、没有工具、没有提示词文本：存储的数据不会到达模型。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-per-workspace
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-per-workspace build
dsh plugin --profile web add ./plugins/agent-preset-per-workspace
```

需要重启 `dsh web`——host 半部只在激活时加载一次，因此重新构建后必须重启。不要假设有 HMR。

**`desktop` profile 对 CLI 关闭**：`dsh plugin --profile desktop …` 会以 *"profile "desktop" is managed exclusively by the Electron application"* 拒绝。请通过应用自带的插件管理器安装本 Bundle，或手动把依赖与 `dsh.profile.bundles` 条目加进 `$DSH_HOME/profiles/desktop/package.json`，再在该目录执行 `pnpm install`。两个 profile 必须分别配置，它们不共享 bundle 列表。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-per-workspace
```

## 文档

实现说明：[`docs/plugins/agent-preset-per-workspace.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-per-workspace.md)。

## 许可

MIT
