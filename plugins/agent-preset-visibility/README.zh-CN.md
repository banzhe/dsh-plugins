# @banzhe/dsh-agent-preset-visibility

把你选定的 agent preset 从预设选择器里隐藏掉，并在设置里提供一个页面来勾选隐藏哪些。隐藏只是列表过滤：被隐藏的 preset 仍然注册，仍然支撑已经在用它的会话，也仍然服务任何指名调用它的委派。

[English](./README.md)

面向 **web** profile 的 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle：过滤挂在浏览器的清单读取上，因此需要 Web Client，在纯 Host profile 上不会产生效果。

## 功能

- **预设可见性**——Settings 下的一页，列出全部已声明的 preset（内置与自定义），显示 id 与显示名，每行一个复选框。勾选表示「在选择器里显示」，取消勾选即隐藏。
- 隐藏一次性覆盖三个 web 清单界面：新会话首屏 chip、会话头标签、Settings 里的 preset 清单。各选择器会在下次打开时重新读取清单。
- 不禁用、不改写任何东西：被隐藏的 preset 保留注册，因此 home patch 里的 `agentPreset:` 引用仍能绑定它，select 与 resolve 照常工作，由它组合的每个子代理也照常运行。
- 隐藏当前默认 preset **不会**改变新会话使用哪个 preset——默认值是本 Bundle 从不写入的设置字段。
- 隐藏清单存放在 profile patch 里，重启后仍然有效；下一次清单读取即生效，无需重启。
- 默认是空清单：在你取消勾选之前，所有 preset 都显示。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-agent-preset-visibility
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-agent-preset-visibility build
dsh plugin --profile web add ./plugins/agent-preset-visibility
```

装完需要重启 **dsh web**：Host 行只在激活时加载一次，重新构建后必须重启。不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-agent-preset-visibility
```

## 文档

实现说明、过滤落点的设计论证与已知限制：[`docs/plugins/agent-preset-visibility.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/agent-preset-visibility.md)。

## 许可

MIT
