/** Locale bundles for the Dev Container variants page (namespace `devcontainer`). */

export type DevcontainerVariantsKey =
  | 'nav' | 'intro'
  | 'devcontainerTitle' | 'devcontainerDescription' | 'sbxTitle' | 'sbxDescription'
  | 'checked' | 'unchecked' | 'derivedBadge' | 'pendingBadge' | 'brokenBadge' | 'variantBrokenBadge'
  | 'noneChecked' | 'checkedCount' | 'sbxNoneChecked' | 'sbxCheckedCount'
  | 'loading' | 'failed' | 'retry' | 'unavailable' | 'readOnly'
  | 'writeFailed' | 'refreshHint' | 'empty' | 'sbxEmpty'
  | 'imageTitle' | 'imageDescription' | 'imagePlaceholder' | 'imageInvalid'

export const en: Record<DevcontainerVariantsKey, string> = {
  nav: 'Dev Container presets',
  intro: 'Check a preset to derive copies of it. A “(devContainer)” copy sends every command into the repository\'s Linux Dev Container; an “(sbx)” copy runs in a Docker Sandbox. The two tracks are independent, nothing is derived until you check something, and a copy disappears again as soon as you clear its box.',
  devcontainerTitle: 'Dev Container runtime',
  devcontainerDescription: 'The regular container environment built from the repository\'s .devcontainer declaration: every command runs inside the Linux container the Dev Container CLI builds and starts.',
  sbxTitle: 'Docker Sandbox runtime',
  sbxDescription: 'Hardware-isolated execution in a Docker Sandbox (MicroVM): each session gets its own micro VM with Docker ready to build out of the box, and no repository declaration is needed.',
  checked: 'derived',
  unchecked: 'not derived',
  derivedBadge: 'Available',
  pendingBadge: 'Wait for it',
  brokenBadge: 'Cannot load',
  variantBrokenBadge: 'Variant cannot mount',
  noneChecked: 'No preset is derived.',
  checkedCount: '{count} derived',
  sbxNoneChecked: 'No Docker Sandbox copy is derived.',
  sbxCheckedCount: '{count} derived as (sbx)',
  loading: 'Loading presets…',
  failed: 'Presets could not be loaded.',
  retry: 'Retry',
  unavailable: 'This plugin is not loaded, so there is nothing to configure.',
  readOnly: 'This deployment stores settings read-only.',
  writeFailed: 'The deployment did not accept this change.',
  refreshHint: 'Preset pickers re-read the roster the next time one opens.',
  empty: 'This deployment declares no preset to derive from.',
  sbxEmpty: 'This deployment declares no preset to derive a Docker Sandbox copy from.',
  imageTitle: 'Sandbox template image',
  imageDescription: 'Leave it empty to use the shell template\'s own image. It reaches sbx create --template only when a Docker Sandbox is created, so an existing sandbox of the same name is reused rather than rebuilt. The image must provide /bin/sh, cat, mkdir, and Node.js 18 or newer.',
  imagePlaceholder: 'docker.io/org/img:tag',
  imageInvalid: 'Only one image name is accepted: no whitespace, and no leading “-”.',
}

export const zh: Record<DevcontainerVariantsKey, string> = {
  nav: 'Dev Container 预设',
  intro: '勾选一个预设即可派生它的副本：「(devContainer)」副本把每条命令送进仓库指定的 Linux Dev Container，「(sbx)」副本在 Docker Sandbox 中执行。两组互相独立，默认都不派生；取消勾选后副本立即注销。',
  devcontainerTitle: 'Dev Container 运行环境',
  devcontainerDescription: '基于仓库 .devcontainer 声明的常规容器运行环境：命令在 Dev Container CLI 构建并启动的 Linux 容器里执行。',
  sbxTitle: 'Docker Sandbox 运行环境',
  sbxDescription: '基于 Docker Sandbox (MicroVM) 的硬件级隔离执行环境：每个会话独占一台微虚拟机，开箱即用支持 Docker 构建，不依赖仓库声明。',
  checked: '已派生',
  unchecked: '未派生',
  derivedBadge: '已可用',
  pendingBadge: '等待注册',
  brokenBadge: '无法加载',
  variantBrokenBadge: '派生副本不可用',
  noneChecked: '当前没有派生任何预设。',
  checkedCount: '已派生 {count} 项',
  sbxNoneChecked: '当前没有派生任何 Docker Sandbox 副本。',
  sbxCheckedCount: '已派生 {count} 项 (sbx)',
  loading: '正在加载预设…',
  failed: '无法加载预设。',
  retry: '重试',
  unavailable: '该插件当前未加载，无需配置。',
  readOnly: '本部署的设置为只读。',
  writeFailed: '本部署没有接受这次修改。',
  refreshHint: '预设选择器下次打开时会重新读取清单。',
  empty: '本部署没有可派生的预设。',
  sbxEmpty: '本部署没有可派生 Docker Sandbox 副本的预设。',
  imageTitle: '沙盒模板镜像',
  imageDescription: '留空则使用 shell 的默认镜像。仅在新建沙盒时传给 sbx create --template，已存在的同名沙盒不会重建。镜像需提供 /bin/sh、cat、mkdir 和 node 18 或更高版本。',
  imagePlaceholder: 'docker.io/org/img:tag',
  imageInvalid: '只接受单个镜像名：不能含空白，也不能以「-」开头。',
}
