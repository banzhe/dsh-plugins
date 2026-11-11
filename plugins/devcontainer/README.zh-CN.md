# @banzhe/dsh-devcontainer

让 Agent 的每条命令都在仓库指定的 Linux Dev Container 里执行，并让模型以为自己本来就在 Linux 里：用 `bash`、写 Linux 路径、写 Linux 命令。声明了 Dev Container 的仓库走容器；其他目录保持原有本地 shell 行为，一切照旧。

[English](./README.md)

仅 Host 端的 [DSH](https://github.com/deepseek-ai/deepseek-harness) Bundle，适用于 **web**、**desktop** 与 **CLI** profile。

## 功能

- **仓库级发现。** 执行器从命令指向的目录向上查找，取最近的声明：先 `.dsh/devcontainer.json` / `.dsh/docker.json`，再 `.devcontainer/devcontainer.json`，最后 `.devcontainer.json`。三者都接受 JSONC（注释与尾随逗号）。
- **真正在容器里跑。** 命令通过 `docker exec -i -w <容器内工作目录>` 执行：容器来源可以是配置里显式的 `container`/`containerName`，可以是 Dev Container CLI 打过 `devcontainer.local_folder=<仓库>` 标签的运行中容器，也可以由 `devcontainer up` 现场构建。
- **进出都是 Linux 路径。** `ctx.shell` 把工作目录报成容器路径（`/workspaces/<仓库>/src`），而进程本身从宿主机仓库根启动——Windows 上的 `child_process` 无法进入不存在的 Linux 路径。
- **会话目录是宿主路径。** `WorkingDirectoryService` 记录的是 `ctx.fs.processPath` 的返回值，而 Windows 宿主机上的容器路径并不是宿主路径：`/f/personal/repo` 会让 `.git` 探测落到 `F:\f\personal\repo\.git`——一个不属于任何仓库的目录，拒绝直接让委派的 `… (sbx)` 子代理在第一步之前失败。因此对 Windows 根目录的仓库，`processPath` 返回容器目标对应的宿主路径；容器路径只保留两处用途：启动运行时的 argv（`cd -- /f/personal/repo`）和 RPC 请求的载荷。
- **宿主进程从宿主能进入的目录启动。** `(devContainer)` 会话的每个接缝都在说容器路径，但子进程无法在其中启动：`run_code` 的 PTC Worker 在第一次 `tools.read` 之前就以 `spawn … ENOENT` 失败。插件装饰了 `ctx.subprocess.spawn`：属于已发现仓库的工作目录会被反向映射回该仓库的宿主机根目录（POSIX 相对路径运算，加上宿主根目录自己的分隔符风格，Windows、Linux、macOS 走同一份代码），而普通会话、宿主路径、无声明归属的容器路径原样交给 provider。只有工作目录被改写：Worker 之后对文件做的一切仍然是 `ctx.fs`，仍然走容器内的 RPC 管道。`ctx.ptcRuntime` 出于同一原因被装饰在自己的两个入口上：`resolve` 会用沙箱策略的 workspace root（容器的 `/workspaces/<repo>`）补齐调用方没有给出的目录，`run` 再把这个目录交给要 `chdir` 进去的 Worker，因此两者都把容器路径转成宿主机仓库根目录，其余请求与 spec 原样交给 provider。
- **文件读写也进容器。** `(devContainer)` 会话的 `ctx.fs` 把每个操作——`resolve`、`stat`、`lstat`、读取、目录列举、字节区间、`write`、`edit`、`patch`、`delete`、`move`——通过一条常驻 stdio RPC 管道交给容器内的 Node helper 执行（沿用 DSH SSH helper 的帧格式，协议版本 3）。路径解析、符号链接跟随与实际 I/O 都发生在容器里，宿主机不会打开任何文件，`read`、`write`、`edit`、`glob`、`grep`、`working_directory` 照旧用 Linux 路径。普通预设保持原行为：把容器视角（`/workspaces/<仓库>/…`，以及 Windows 模型误解析出的 `F:\workspaces\<仓库>\…`）映射回宿主机 bind mount，沙箱写入围栏原样继承。
- **Linux 提示词。** `working-directory:current` 上下文被改写为 `Current working directory: "/workspaces/<仓库>"` 并追加 `Runtime environment: Linux Docker container … always write POSIX/Linux commands and never PowerShell commands`。
- **不串环境变量。** 进入容器的只有 `remoteEnv`、调用方自己的条目、`DSH_*` 快照，以及 `TERM=dumb`/`GIT_TERMINAL_PROMPT=0`/`NO_COLOR=1`：没有宿主机 `PATH`，没有 `SystemRoot`。宿主一侧同样清洗：Docker / Dev Container CLI 只带着白名单变量启动（找到 `docker` 与读取你自己的 Docker 配置所需的那几个，加上 `DOCKER_*`/`XDG_*` 家族，并剔除名字像凭据的变量），DSH 自己的凭据不会进入它，也不会进入它启动的进程。
- **设置页按需派生预设。** Windows 上官方预设挂 `pwsh`、禁用 `bash`；Dev Container 是 Linux，所以在**设置 → Dev Container 预设**页勾选某个预设，就会派生它的 `… (devContainer)` 副本（例如 `委派模式 (devContainer)`、`标准模式 (devContainer)`）：改用 `bash`，子代理也指向各自派生的副本，路由最多追踪四层；到达上限的路由会被切断（从可选列表里移除，或禁用整行固定路由），而不是留成原版宿主预设。该页分成两组，互不影响：**Dev Container** 组写 `sources`、派生的预设名后缀是 `(devContainer)`，**Docker Sandbox** 组写 `sbxSources`、后缀是 `(sbx)`。默认不派生任何预设，取消勾选立即注销副本；原有预设一律不改——本来不挂 shell 工具的预设（委派模式主代理）派生后依然不挂。
- **Docker Sandbox（`sbx`）是第二条派生轨道，且不需要任何声明文件。** `… (sbx)` 预设由新的 `sbxSources` 列表派生，机制与 `sources` 派生 `… (devContainer)` 完全一致：同样翻转 shell 工具、同样限深的子代理路由，但每条轨道只会把子代理指向自己这条轨道的副本。因为沙箱只需要一个宿主目录、不需要任何构建描述，仓库不需要 `.devcontainer/devcontainer.json`：首次使用时会列出（`sbx ls --json`）、创建（`sbx create --name … shell <仓库根>`）并以 detach 方式启动（`sbx run --detach --name …`）名为 `dsh-<仓库>-<哈希>` 的沙箱，命令以 `sbx exec <名字> -- /bin/sh -c "cd -- '<工作目录>' && exec … '<shell>' -c '<命令>'"` 执行。`ctx.fs` 通过 `sbx exec -i <名字> -- node …` 复用同一个容器 helper，读写都发生在沙箱内部；缺少 `sbx` CLI 时给出的是安装指引，而不是「沙箱不存在」。文件调用报出的路径是沙箱挂载的拼写（`/f/personal/repo`），它根本不是宿主路径，而一行配置服务宿主上的所有会话、其 `cwd` 是启动 DSH 的目录：宿主目录由 `sbx ls` 报告的挂载反解得出（最深的挂载优先，并直接给出工作区根目录，无论仓库有没有声明文件），只有仓库确实在该盘符路径上声明了容器时才采用盘符约定，因此落在所有挂载之外的路径仍然在宿主侧被拒绝。shell 行在查找仓库之前会先反解同一个拼写，因此即使该行挂载时没有配置 `cwd`，工作目录 `/f/personal/repo` 也会进入该目录对应的沙箱。
- **宿主的 `AGENTS.md` 与技能跟着沙箱一起可见。** `… (sbx)` 预设把宿主的全局 agent 配置以只读方式挂到工作区旁边——宿主行配置项 `hostMounts`，默认 `auto`：`<dshHome>/AGENTS.md`、`<agentsHome>/AGENTS.md`、`<dshHome>/skills`、`<agentsHome>/skills`——于是沙箱会话读到的技能与说明和在宿主上一致。宿主上不存在的源会被跳过并告警，所有挂载一律只读，围栏只放行声明的这几条。详见[在沙箱会话中使用宿主机全局 AGENTS.md 与技能](#在沙箱会话中使用宿主机全局-agentsmd-与技能)。
- **普通预设的本地兜底沿用平台自己的 shell。** 没有声明 Dev Container 的目录保持安装前的本地执行器：POSIX 上用 bash，Windows 上用 PowerShell（`pwsh -NoLogo -NoProfile -NonInteractive -Command`）。因此普通的 `pwsh` 工具在容器仓库之外照常可用。
- **容器路由跟随预设。**`… (devContainer)` 预设把每条命令送进仓库容器；普通预设保持原来的宿主机 shell，即使该仓库声明了容器。想让所有会话都走容器，请在各行设置 `requireContainer: true`。
- **`(devContainer)` 预设不会悄悄在宿主机上跑命令。** shell 工具会给来自派生预设的每次调用打标记，所以仓库没有容器配置时：工作目录上下文里会出现明确警告（要求模型立刻用中文说明情况并停止重试），执行器**直接拒绝**执行并返回 `exitCode: 1` 与诊断信息，而不是回退到宿主机。普通预设不受影响。
- **文件读写与命令一起被拒绝。** `ctx.fs` 按发起调用的 agent 读取同一个预设（子代理用自己的 Session 作答），所以在没有容器配置的仓库里，`resolve`、`read`、`write`、`edit`、`stat` 与目录列举都会被拒绝并抛出结构化的 `FS_PERMISSION_DENIED`：宿主机上的文件不会被读取、写入或创建。仓库确实声明了容器时，`(devContainer)` 会话整体委托给该容器执行；普通预设照旧直读宿主机文件系统。仅仅「看起来在仓库里」不算数：解析到仓库挂载点之外的符号链接会被同样拒绝，诊断信息会指出真实的链接目标。

仓库用三种形态中的任意一种接入，例如：

```jsonc
// .devcontainer/devcontainer.json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "workspaceFolder": "/workspaces/my-repo",
  "remoteUser": "vscode",
  "remoteEnv": { "CI": "1" },
}
```

```jsonc
// .dsh/docker.json —— 轻量形态：直接复用一个已经在跑的容器
{
  "container": "my-repo-dev",
  "workspaceFolder": "/workspaces/my-repo",
}
```

字段全表、驱动回退顺序与预设机制见实现说明文档。

## 在沙箱会话中使用宿主机全局 AGENTS.md 与技能

使用 `… (devContainer)` 或 `… (sbx)` 预设时，会话跑在对应沙箱的文件系统围栏之内：工作区挂载点之外的路径一律被拒绝，因此宿主上的全局技能目录（例如 `~/.agents/skills`）在沙箱里看不到。宿主的全局 agent 配置改为以只读方式挂进沙箱，并像其他文件一样经 `ctx.fs` 读取。

挂载哪些路径由宿主行的 `hostMounts` 决定。默认值 `auto` 取宿主的 `AGENTS.md` 与技能目录，且每一项只在宿主上确实存在时才挂：

| 宿主路径 | 挂载形态 |
| --- | --- |
| `<dshHome>/AGENTS.md` | 只读单文件 |
| `<agentsHome>/AGENTS.md` | 只读单文件 |
| `<dshHome>/skills` | 只读目录 |
| `<agentsHome>/skills` | 只读目录 |

`dshHome` 与 `agentsHome` 由 DSH 自己解析（`$DSH_HOME` / `$DSH_AGENTS_HOME`，否则是 `~/.dsh` 与 `~/.agents`），所以改了环境变量后沙箱挂载的就是那个目录。把 `hostMounts` 设为 `'off'` 则什么都不挂；也可以自己列 `PATH[:TARGET][:ro]` 条目，无论写成哪种形态，挂载一律只读。

宿主上不存在的源会被跳过并给出一条指名路径的告警，而不是让创建失败——也不会在宿主上创建任何文件。挂载在创建时固定：之后再补的路径需要 `sbx rm <沙箱>` 重建才能被沙箱看见；已经在运行的沙箱则实时读取它挂载的内容，改动或替换文件立刻生效。

围栏只承认这些挂载：即 `hostMounts` 声明的路径，翻译成沙箱里实际挂载的位置。沙箱自己上报的其他挂载（例如 `sbx` 注入的 agent 技能库）仍然不可达。整个过程不涉及环境变量，也不需要重启 DSH。

## Docker Sandbox 镜像

新建 Docker Sandbox 时默认运行 Docker 自带的、不带 agent 的 `shell` 模板。若想换成指定镜像，在**设置 → Dev Container 预设**页的“沙盒模板镜像”一栏填写：该值存为 `sbxTemplate`，并以 `sbx create --template <镜像>` 传入，插在位置参数 agent 与工作区目录之前。这一栏和两份预设列表一样是设置页写入的，会一并落进 profile。

```text
sbx create --name <沙箱> shell <仓库根>                          # 未设置 sbxTemplate
sbx create --name <沙箱> --template <镜像> shell <仓库根>          # 已设置 sbxTemplate
```

默认值是 `""`，只含空白的值同样视为未设置，因此没配置过的行发出的 argv 与以前完全一致。镜像必须是单独一个 argv：自身不含空白、不以 `-` 开头；因此 `docker.io/org/img:tag`、带 digest 的引用（如 `docker.io/org/img@sha256:…`）以及本地模板名（如 `my-template:v1`）都可用，不要求写 registry 域名。其他取值会被该行的 schema 拒绝，也不会带着无法作为单个参数的值去调用 `sbx create`。这里用的是 CLI 的镜像标志，不是位置参数 agent：`shell` 仍然是沙箱启动的 agent，且不提供 `--kit`、CPU、内存之类的设置。

该设置只在由本插件创建沙箱时生效。同名沙箱已经存在时直接复用，已停止则启动，不会因为改了镜像就删除并重建；要换镜像需自行 `sbx rm` 该沙箱。无论用哪个镜像，都必须提供 `/bin/sh`、`cat`、`mkdir`，以及 Node.js 18 或更新版本（文件系统 helper 和经由它的工具调用需要）。

## 安装

### 从 npm

```sh
dsh plugin --profile web add @banzhe/dsh-devcontainer
```

### 从本地检出

```sh
pnpm install
pnpm --filter @banzhe/dsh-devcontainer build
dsh plugin --profile web add ./plugins/devcontainer
```

装完重启 `dsh web`（或 CLI 会话）：本 Bundle 在激活时替换 `ctx.shell` 与 `ctx.fs`，预设变体则要等 Loader 树稳定后才注册。请不要指望 HMR。

**`desktop` profile 不对 CLI 开放**：请通过应用自带的插件管理器安装，或手工把依赖与 `dsh.profile.bundles` 条目写进 `$DSH_HOME/profiles/desktop/package.json` 后在该目录执行 `pnpm install`。各 profile 的 bundle 列表互不共享。

卸载：

```sh
dsh plugin --profile web remove @banzhe/dsh-devcontainer
```

## 文档

实现说明：[`docs/plugins/devcontainer.md`](https://github.com/banzhe/dsh-plugins/blob/master/docs/plugins/devcontainer.md)。

## 许可

MIT
