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
    "@deepseek-ai/cordis": "^4.0.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3"
  }
}
```

Add further `@deepseek-ai/dsh-*` packages as **peer + dev**, never as `dependencies`. Runtime modules come from the DSH install tree.

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

English. What the Bundle contributes, which Profile it is meant for, and the install command.

## Guardrails

- Do not change a Patch `name` to a relative source path. Installed Bundles resolve through Node.
- Do not depend on a sibling plugin or a DSH git checkout.
- Do not add a shared `packages/` tree until a second Plugin actually reuses code.
