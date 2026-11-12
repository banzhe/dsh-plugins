# @banzhe/dsh-session-topic-map

右侧栏里的主题图：把当前会话读成一张会分叉的主题图，点一个方框就跳回产生它的那条回复。

[English](./README.md)

适用于 **web** profile 的双端 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle。

## 功能

- 右侧栏里一个会话级的页签（`kind: session-topic-map`），并带一条引导页入口。
- 列出 profile 当前提供的模型，用你选中的那个分析对话。按下「开始分析」之前不会向模型发出任何请求；没有携带确认的分析请求会被 Host 拒绝。
- 只读上一次分析完成之后新增的消息，所以第二次运行接着上次的位置继续，不会重复计费同一段对话。
- 确认之后自己保持更新：积压的消息会连续多批分析完，安静下来后每两秒再看一次，这一次不会调用模型。
- 暂停、切换会话或离开页签都会停下；恢复时一定需要重新确认。
- 一条回复一个方框：同时讲了两件事的回复是一个携带两个主题的进展点，后面的回复可以只续接其中一个或两个都续接，分叉与合流就是这样画出来的。
- 按会话分别存进插件自己的存储域，所以切换会话或重启 `dsh web` 后每张图都还在。
- 点击方框时通过对话里的 `data-chat-turn` 标记跳到这个方框自己那条回复并描边高亮，不改动聊天渲染层。
- 不写会话日志，也不为其他目的调用模型。

## 安装

### 从 npm

```sh
dsh plugin --profile web add @banzhe/dsh-session-topic-map
```

### 从本地检出

```sh
pnpm install
pnpm --filter @banzhe/dsh-session-topic-map build
dsh plugin --profile web add ./plugins/session-topic-map
```

然后重启 `dsh web`。Client 部分在 watcher 改写 `lib/client.js` 时热重载；Host 部分仍需重启。改源码后要重新构建 `lib/`。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-session-topic-map
```

## 文档

实现说明：[`docs/plugins/session-topic-map.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/session-topic-map.md)。

## 许可

MIT