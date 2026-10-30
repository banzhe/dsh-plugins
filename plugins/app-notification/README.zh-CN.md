# @banzhe/dsh-app-notification

把「已完成未读」的会话数投影到已安装 PWA 的图标角标上，并在页面打开期间每个完成的会话发一条系统通知。

[English](./README.md)

Web Client [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web** profile。

## 功能

- 角标数跟随侧栏的绿色完成圆点——已完成且尚未打开的普通会话——且永远不会高于它。`origin: 'subagent'` 的行被排除。
- 仍在等待运行中子代理后代的会话（子代理，或空闲子代理背后的孙代理）既不计数也不通知；它的通知推迟到最后一个后代结束的那一刻。
- 已归档的会话不计数也不通知。归档一个已完成会话会把它从角标里撤下；取消归档会静默地重新计入。
- 每个新完成的普通会话发一条标记为 `dsh-session-completed` 的通知；连续完成会替换而非堆叠。
- 点击通知会聚焦当前窗口，然后打开该会话。
- 首次观察只同步状态：刷新页面只显示当前数量，不会重新播报「无人观察期间」完成的会话。
- 通用设置里的一行（`settings.general.item`，id 为 `app-badge`）显示实时能力状态，并且是唯一可以调用 `Notification.requestPermission()` 的用户手势入口。
- 激活时绝不请求权限，不持久化开关，也没有 service worker 或 push——页面关闭后不会通知。
- 既没有 badging 也没有 `Notification` 构造器的页面仍会注册词典与设置行，因此该状态读数能解释「为什么没有通知」。

## 安装

### 通过 npm

```sh
dsh plugin --profile web add @banzhe/dsh-app-notification
```

### 通过本地代码 link

```sh
pnpm install
pnpm --filter @banzhe/dsh-app-notification build
dsh plugin --profile web add ./plugins/app-notification
```

把 Bundle 加入 `dsh.profile.bundles` 需要重启进程。之后改动源码要重新构建 `lib/` 并刷新 GUI；不要假设有 HMR。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-app-notification
```

## 文档

实现说明：[`docs/plugins/app-notification.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/app-notification.md)。
