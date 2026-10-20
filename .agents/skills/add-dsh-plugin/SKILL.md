---
name: add-dsh-plugin
description: Add a DSH plugin Bundle under plugins/<name>/. Use when creating a new plugin, scaffolding a Bundle, adding a plugin package, or installing a new plugin into this workspace.
---

# Add a DSH plugin

Create one installable Bundle at `plugins/<name>/`. The package name is `@banzhe/dsh-<name>`. Terms (Plugin, Bundle, Profile, Patch) live in [CONTEXT.md](../../../CONTEXT.md).

Do not edit the workspace glob, root tsconfig, or another plugin. Do not put more than one Plugin in a Bundle unless they must enable as one layer.

## 1. Confirm the name

`<name>` is kebab-case, unscoped, unique under `plugins/`. Package name is `@banzhe/dsh-<name>`. Loader row `id` is `<name>`.

Done when `plugins/<name>/` does not already exist and the three identifiers match.

## 2. Write the Bundle files

Create exactly these files. Templates are below.

Done when every listed file exists and the Patch `name` is the package name, not a relative path.

## 3. Install, build, typecheck

```sh
pnpm install
pnpm --filter @banzhe/dsh-<name> build
pnpm --filter @banzhe/dsh-<name> typecheck
```

Done when `plugins/<name>/lib/index.js` exists and typecheck exits 0.

## 4. Install into the web Profile (when asked)

```sh
dsh plugin --profile web add ./plugins/<name>
```

Done when `$DSH_HOME/profiles/web` lists `@banzhe/dsh-<name>` in `dsh.profile.bundles`. Rebuild `lib/` after later source changes; do not assume HMR.

## File templates

### `package.json`

```json
{
  "name": "@banzhe/dsh-<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/index.d.ts", "cordis.patch.yml"],
  "scripts": {
    "build": "tsdown",
    "prepare": "tsdown",
    "typecheck": "tsc --noEmit"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5-alpha.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:"
  }
}
```

Add further `@deepseek-ai/dsh-*` packages as **peer + dev**, never as `dependencies`. Runtime modules come from the DSH install tree. Peer ranges are caret ranges matching the DSH version the plugin was built against, not `catalog:` (pnpm publish does not expand `catalog:` in peers).

`devDependencies` use `"catalog:"`: versions live in the root `pnpm-workspace.yaml` `catalog:` block. If the package is missing from that catalog, add one line there first.

### `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib"
  },
  "include": ["src"]
}
```

### `tsdown.config.ts`

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
})
```

### `cordis.patch.yml`

Insert only this Bundle's Loader rows.

```yaml
- insert:
    - id: <name>
      name: '@banzhe/dsh-<name>'
```

### `src/index.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = '<name>'

export function apply(_ctx: Context) {}
```

Add `inject` when the Plugin waits on a service. Add a Schemastery `Config` export when the Loader row has `config`. Do not write a Client plugin (`dsh.client`, `src/client/`) unless the task is a Web Client contribution.

### `README.md`

English. Two sections only: what the Bundle contributes, and how to install it.
Which Profile it is meant for belongs in the contribution section.

Install covers both routes: `dsh plugin --profile <name> add @banzhe/dsh-<name>`
(npm) and a local checkout (`pnpm install`, `pnpm --filter … build`, then
`dsh plugin --profile <name> add ./plugins/<name>`), each with its removal
command.

Implementation notes, design rationale, and known limitations go to
`docs/plugins/<name>.md`, not here.

Two sections stay in the README whatever else moves out, because `docs/` is not
published to npm and no package here carries a `license` field or a `LICENSE`
file:

- **Credits** — when the Bundle derives from someone else's work. Name the source,
  its license, and its copyright holder.
- **License** — the Bundle's own (`MIT`).

### `README.zh-CN.md`

The Chinese counterpart of `README.md`: the same sections, translated, with a
`[English](./README.md)` link at the top. `README.md` carries the matching
`[中文版](./README.zh-CN.md)` link. Translate the Credits and License headings too
(`致谢` / `许可`) and keep the license name itself as `MIT`.

## Guardrails

- Do not change a Patch `name` to a relative source path. Installed Bundles resolve through Node.
- Do not depend on a sibling plugin or a DSH git checkout.
- Do not add a shared `packages/` tree until a second Plugin actually reuses code.
