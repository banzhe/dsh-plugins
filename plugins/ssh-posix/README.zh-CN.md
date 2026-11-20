# @banzhe/dsh-ssh-posix

官方 OpenSSH 连接服务的个人 fork：让 **Windows** 本地宿主驱动 **POSIX** 远端主机。

[English](./README.md)

面向 Host 侧的 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle。它提供 `ssh` 服务（`ctx.ssh`）与一层「远程专用」profile 补丁，所以它属于专门跑远端的 profile，而不是你用来处理本机文件的 profile。

## 状态：开发中

尚未发布。包标记为 `private`，并列入本仓库 changesets 的 `ignore` 数组，因此发版 PR 与 publish 步骤都不会动它；请按下文的本地检出方式安装。首次发版时，去掉 `private`、去掉 `ignore` 条目、并提交一个 changeset，三件事一起做。

## 功能

- **官方 SSH provider 消费的那个连接服务。** `ctx.ssh` 就是官方 `@deepseek-ai/dsh-fs-ssh`、`@deepseek-ai/dsh-subprocess-ssh`、`@deepseek-ai/dsh-sandbox-ssh` 绑定的同一服务：一条 OpenSSH 别名承载私有管理通道，每条程序流都是凭该通道密钥派生的独立 TLS-PSK 通道。远端侧是官方、带摘要校验的 POSIX 辅助程序；本 Bundle 不 fork 辅助程序。
- **Windows 本地宿主可以启动。** 官方连接在构造时拒绝非 POSIX 客户端；本 fork 把这条拒绝换成对本地 OpenSSH 客户端的探测：缺少 `ssh` 或无法使用就在启动时报错，错误里带平台、命令与客户端自己的答复；客户端可用时连接据此选择转发方式——这个选择不对外输出。
- **两种转发方式，由探测决定。** POSIX 宿主且客户端是 OpenSSH 时保留官方方式：一个 OpenSSH master 复用管理通道并用 `-O forward` 管理 Unix socket。其余情况——Windows 一律如此，POSIX 宿主上未识别为 OpenSSH 的客户端也一样——为每条流单独开一个长期存活的 `ssh -L` 子进程，绑定回环端口，因为 Win32-OpenSSH 的复用与 Unix socket 转发未经验证。
- **临时文件放在平台临时目录**而不是 `/tmp`，控制 socket 与转发 socket 落在宿主的临时文件位置。
- **一层「远程专用」profile 补丁。** 包内补丁用三行 SSH provider 替换本地 provider 行，并启用 POSIX shell 工具：加载后文件、进程与沙箱全部改为寻址 SSH 主机。请放进专门的 profile——它不是叠加式的。Web UI 是例外：工作区视图仍假定本机文件系统，替换 provider 并不会让这些视图认识远端。
- **helper 由宿主推送安装。** 设置 `provision.source` 指向 release 归档后，连接自己负责安装 helper：读出归档 manifest 声明的入口摘要，用一条自己的 SSH 命令在远端 `sha256sum` 探测入口，只有在入口缺失或摘要不符时才推送归档——远端重新校验收到的字节，解压到入口旁以摘要命名的目录，再用一条同目录符号链接原子换到配置路径上。入口摘要已匹配时一个字节都不传。不配 `provision` 则一切照旧：helper 必须已预装，且必须声明 `helperHash`。
- **远端启动命令按真正的解析 shell 加引号。** 辅助程序启动命令（含 `--disable-sigusr1` 保护与 PTC bootstrap）由 target-shell 策略生成；POSIX 命令与官方逐字节一致。

## 安装

本 Bundle 需要 profile 里能解析到三个 SSH provider：`@deepseek-ai/dsh-fs-ssh`、`@deepseek-ai/dsh-subprocess-ssh`、`@deepseek-ai/dsh-sandbox-ssh`。官方发行版安装树不含它们，需要一个自行组合它们的 profile（或提供它们的源码工作区）。

### 从 npm 安装

```sh
dsh plugin --profile <name> add @banzhe/dsh-ssh-posix
```

### 从本地检出安装

```sh
pnpm install
pnpm --filter @banzhe/dsh-ssh-posix build
dsh plugin --profile <name> add ./plugins/ssh-posix
```

两条路径都需要连接自身的配置：`host` 别名（连同既有的用户、密钥与 known_hosts 条目）、`launch`、`helper`、`workspace`，以及 helper 摘要——用 `helperHash` 声明，或交给 `provision.source` 安装并推导。这些值写进 profile 自己的补丁，并且要把远端工作区写两处——一处给连接，一处给包内补丁留作占位符的写入根：

```yaml
- id: ssh-posix
  config:
    host: my-posix-host
    launch: { kind: executable }
    helper: /home/deploy/dsh-ssh-helper
    helperHash: <该文件的小写 sha256>
    workspace: /home/deploy/project

- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: /home/deploy/project
```

若要从 release 归档自动安装 helper，把 `helperHash` 换成 `provision.source`（指向归档的宿主本地绝对路径）；若仍显式声明 `helperHash`，它必须等于归档 manifest 列出的入口摘要，否则 profile 加载失败。推送安装要求远端有 `sha256sum`、`tar` 与符号链接支持，且 `helper` 的父目录可写；它只与 `launch: { kind: executable }` 搭配。

`config.workspace` 与 `workspaceRoot` 必须保持一致：前者是辅助程序的默认工作区，后者是沙箱策略授予的写入根。字段清单与远端主机的前置条件见实现说明。加载后需重启该 profile；之后改源码要重新构建 `lib/`。

移除：

```sh
dsh plugin --profile <name> remove @banzhe/dsh-ssh-posix
```

## 文档

fork 面、五处改动、转发方式判定、测试清单与已知限制见 [`docs/plugins/ssh-posix.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/ssh-posix.md)。

## 致谢

fork 自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh-ssh`（MIT © DeepSeek，`my_dev @ 3a01e5a`）。连接生命周期、协议、校验 schema、流认证、远端辅助程序与全部移植的测试用例都是该包的工作；宿主能力探测、每流转发方式、临时目录策略与 target-shell 策略属于本 Bundle。

## 许可

MIT
