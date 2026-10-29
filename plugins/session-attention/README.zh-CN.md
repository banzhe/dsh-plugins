# @banzhe/dsh-session-attention

一个 `shell.overlay` 面板，把需要关注的会话——运行中、在等你、或已完成未读——收在一个开关后面。

[English](./README.md)

Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web**（及 **desktop**）profile。

## 功能

- **开关**——常驻在界面右下角的按钮，带一个显示所列会话数量的角标。角标始终渲染，`0` 也会显示。
- 开关自身边缘的**外描边**表示最高优先级的状态，顺序如下：
  1. **waiting**——所列会话有等待你处理的交互（审批、提问、plan 复核）。琥珀色，静止不动。
  2. **running**——有任务在跑。沿边缘有一圈 2px 的蓝色流动光晕。
  3. **unread**——不是主视图时完成了。绿色，静止不动。
- **面板**——两个分区，最新在前：
  - **进行中**（`Running`）——host 报告该会话正在运行。每行显示当前这轮已进行的时长，从会话最近一次人类提示词算起，因此刷新页面后依然正确；新提示词会重新计时。
    - **运行中的子代理**以缩进块的形式挂在父行下方，各自显示从本轮开始算起的时长。
    - 父会话空闲但有子代理在跑时，会作为容器行列出。
  - **未读**（`Unread`）——不是主视图时完成了，与侧栏绿色圆点是同一事实。
  - 每行使用内置的 `StateDot`：运行中的 spinner、绿色的完成圆点，或该轮在等你时显示琥珀色警告点。等待回答不算活动，因此不显示 spinner。
- **Windows 任务栏**——所列会话正在运行、且没有等待你处理或已完成未读时，桌面应用的任务栏按钮显示系统自带的不确定进度动画。出现等待、未读或列表空闲时清除。浏览器和旧版壳层不会有任何效果。
- **点击某一行**即把该会话显示为主视图；面板随之关闭，未读提醒会自动清除。
- **Escape** 与面板的关闭按钮都能关闭它；打开状态只存在内存中（刷新后回到关闭态）。
- 所有状态颜色都取自 `ui-theme` token，没有一个手写。在 `prefers-reduced-motion` 下光晕停止动画但保留圆环。
- 子代理不作为独立面板行，也不计入角标；空白的新建会话占位同样被排除。
- 已归档的会话不显示，即使宿主仍把它报告为进行中或已完成未读；它们也不计入角标。
- 文案跟随应用语言（`session-attention` 命名空间，zh/en）。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-attention
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-attention build
dsh plugin --profile web add ./plugins/session-attention
```

新的 Bundle 只有在启动时才会进入 client 模块图：重启 DeepSeek Harness，然后刷新页面。之后改动源码要重新构建 `lib/`。不要假设有 HMR。

**`desktop` profile 对 CLI 关闭**：`dsh plugin --profile desktop …` 会以 *"profile "desktop" is managed exclusively by the Electron application"* 拒绝。请通过应用自带的插件管理器安装本 Bundle，或手动把依赖与 `dsh.profile.bundles` 条目加进 `$DSH_HOME/profiles/desktop/package.json`，再在该目录执行 `pnpm install`。两个 profile 不共享 bundle 列表。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-session-attention
```

## 文档

实现说明：[`docs/plugins/session-attention.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-attention.md)。
