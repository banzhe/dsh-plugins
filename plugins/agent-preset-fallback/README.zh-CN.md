# @banzhe/dsh-agent-preset-fallback

当存储或请求的 agent preset 已不存在时，回退到部署默认 preset，而不是让会话创建失败。

[English](./README.md)

Host 侧 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于所有会创建会话的 profile。

## 功能

- 记住了某个 agent preset、而该 preset 后来被删除的空白会话，仍能以部署默认 preset 正常组合。
- 覆盖两条 preset 解析路径：会话控制器的 `resolve` 与注册表内部的 `retain` 分发。
- 只救援非默认 id 上的 `agent-preset/not-found` 与 `agent-preset/invalid`。`agent-preset/locked`、外部错误以及默认 id 本身都原样抛出。
- 卸载时恢复注册表自身的方法。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-fallback
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-fallback build
dsh plugin --profile web add ./plugins/agent-preset-fallback
```

安装或重新构建后需要重启 `dsh web`——本 Bundle 没有 client 半部，其 host 半部只在激活时加载一次。不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-fallback
```

## 文档

实现说明：[`docs/plugins/agent-preset-fallback.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-fallback.md)。
