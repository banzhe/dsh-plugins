# @banzhe/dsh-git

右侧栏的 Git 面板：把当前会话工作区的改动文件以文件夹树展示，并用你填写的消息提交。

[English](./README.md)

双半部 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 右侧栏的一个页签（`kind: git`），并带一个引导入口。
- 以文件夹树列出当前会话工作区的改动文件，并显示每个文件的状态。
- 用输入框中填写的消息提交该工作区。
- 基于改动上下文、用会话自身的模型起草该消息。
- 只服务 profile 已注册的工作区：请求的 `cwd` 必须是绝对路径，且能通过工作区注册表解析。路径不存在与目录未注册返回相同的 `404`。
- 不打开文件的 diff。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-git
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-git build
dsh plugin --profile web add ./plugins/git
```

然后重启 `dsh web`。当 watcher 重写 `lib/client.js` 时，client 半部会热重载；host 改动仍需重启。改动源码后要重新构建 `lib/`。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-git
```

## 文档

实现说明：[`docs/plugins/git.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/git.md)。
