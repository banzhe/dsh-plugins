---
'@banzhe/dsh-devcontainer': minor
---

设置页新增“沙盒模板镜像”（`sbxTemplate`）：创建 Docker Sandbox 时可指定镜像，作为官方 CLI 的 `--template` 传入。字段属于 Host 行（`devcontainer` 命名空间）的 volatile 配置，和 `sources` / `sbxSources` 一样由设置页写入，因此保存后下一条命令即生效；写入的 path 是 `['sbxTemplate']`，与那两份预设列表互不覆盖。默认值为 `""`，未设置（或只含空白）时 argv 与以前完全一致（`sbx create --name <沙箱> shell <仓库根>`）；设置后镜像插在位置参数 agent 之前（`sbx create --name <沙箱> --template <镜像> shell <仓库根>`）。只接受能作为单个 argv 的取值（不含空白、不以 `-` 开头），因此 `docker.io/org/img:tag`、带 digest 的引用和 `my-template:v1` 这类本地模板名都可用；非法值在设置页与 schema 两处都被拒绝，不会传给 `sbx`。该设置只在插件自己创建沙箱时生效：同名沙箱已存在时照旧复用或启动，不会因为换镜像而删除重建；沙箱命名规则不变，位置参数 `shell` 也未变成可配置项。镜像需提供 `/bin/sh`、`cat`、`mkdir` 以及 Node.js 18 或更新版本。
