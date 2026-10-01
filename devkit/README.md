# @banzhe/dsh-devkit

Private build helpers the Bundles in this workspace share. Not published, not a
Bundle: it exists so a tsdown config stops re-implementing the same loaders, and
so a stylesheet is a stylesheet on disk for every plugin here.

`src/tsdown-css.ts` — the stylesheet loaders. DSH's own client preset does this
for the packages inside the harness and cannot be reused here (its loaders live
in a non-exported config factory, and reaching them would drag in harness-internal
paths); this restates the same semantics for an out-of-tree Bundle, the way
community plugin workspaces do.

| Import | What the bundle gets |
|---|---|
| `import css from './Card.module.css'` | lightningcss compiles the sheet with CSS Modules (`[hash]_[local]`); the module installs a tagged `<style>` at factory execution and exports the class map, so the component writes `className={css.row}` |
| `import './base.css'` | the same injector, no class map |
| `import css from './overlay.css?inline'` | the compiled sheet as text, for a plugin that installs the tag itself and takes it back with its fiber (`ctx.effect`) |

All three modes go through lightningcss, so a bundle carries minified CSS. That is
the harness preset's behaviour and the community workspaces' behaviour; the
pre-compile text stays in the source file, which is where an editor reads it.

## Implementation references

None of this is invented here. Each mode, hook name and id shape comes from one of
the three implementations below; why none of them could simply be imported is the
subject of [ADR 0009](../docs/adr/0009-css-as-files.md).

- **Origin: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)** —
  [`packages/client/tsdown.client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/tsdown.client.ts)
  is the preset every UI plugin package inside the harness builds with, and the
  three modes, the virtual-id trick against tsdown's own CSS guard, the injector
  module (`data-plugin`, `data-plugin-css`, tag id `<plugin-id>/<basename>`,
  idempotent install) and `[hash]_[local]` CSS Modules are read off it. It is not
  importable from an out-of-tree Bundle: its loaders sit in a config factory the
  package does not export, and reaching them would drag in harness-internal paths.
  Its [`docs/web-styling.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.md)
  owns the styling rules our sheets follow. The checkout this workspace links its
  `@deepseek-ai/*` overrides to is `../deepseek-harness`.
- **Independent restatement: [`dshplugin/dsh-plugin-hub`](https://github.com/dshplugin/dsh-plugin-hub)** —
  its [`tsdown.config.ts`](https://github.com/dshplugin/dsh-plugin-hub/blob/main/tsdown.config.ts)
  is the harness preset rewritten for a package outside the repo — it arrives at
  the same virtual-id wrapper and injector from the other direction, and says so
  in its header ("mirroring the DeepSeek Harness client preset for an external
  package"). The `registry` option is its idea: a `globalThis.__DSH_PLUGIN_CSS__`
  record for plugin code that re-injects a sheet the page outlived the factory to
  install.
- **Devkit shape: [`morlay/dsh-plugin`](https://github.com/morlay/dsh-plugin)** —
  its [workspace/devkit ADR](https://github.com/morlay/dsh-plugin/blob/main/.agents/adrs/20260917-workspace%E8%B7%A8vendor%E9%93%BE%E6%8E%A5%E4%B8%8Edevkit%E5%B7%A5%E5%85%B7%E9%93%BE%E5%A4%8D%E7%94%A8.md)
  is why these loaders live in a private workspace package the Bundles share
  instead of being copied into every tsdown config: it hoists the same three modes
  into `devpackages/devkit` and pins them with the devkit's own spec. Two
  differences: its `resolveId` carries `order: 'pre'` against a patched upstream,
  which the loaders here do not need (plugin hooks already resolve before the
  default resolver — the builds confirm it), and it records the declaration-graph
  trap of re-exporting a `?inline` text, which the browser faces here avoid with
  `dts: false` plus `src/client/css.d.ts`.

## Use

```ts
import { cssPlugins } from '@banzhe/dsh-devkit'
import { defineConfig } from 'tsdown'

export default defineConfig({
  // …
  plugins: cssPlugins('@banzhe/dsh-my-plugin'),
})
```

The plugin id is stamped onto every injected tag (`data-plugin` and the
`data-plugin-css` tag id `<id>/<basename>`), which is also the idempotency key: a
bundle imported twice installs its sheet once. `cssPlugins(id, { registry: true })`
additionally records each sheet on `globalThis.__DSH_PLUGIN_CSS__` — opt in from
plugin code that re-injects a tag the page lost without re-running the factory
(a host restart leaves the page open and drops injected tags).

## Two behaviours worth knowing

- **A virtual id must not end in `.css`.** tsdown's own CSS guard fails the build
  on such an id without `@tsdown/css`, so every loader wraps its id in a null-byte
  prefix plus an `.mjs` suffix, and registers the physical sheet with
  `addWatchFile` instead.
- **The specs see Vite's transform, not this one.** Vite resolves `?inline` for a
  spec and runs no lightningcss pass, so a Bundle that asserts on its own sheet
  text is asserting the *source* form while the bundle ships the compiled one.
  Keep such assertions to names and rules that survive minification, or pin the
  compiled form here with a fixture instead.

## Test

```sh
pnpm --filter @banzhe/dsh-devkit test          # hooks driven directly, no build
pnpm --filter @banzhe/dsh-devkit test -- --coverage
```

The specs drive `resolveId`/`load` over real sheets in a temp directory and assert
the emitted module text, so a mode that stops working fails here rather than in a
Bundle six months later. Coverage is per-file 100%, like the Bundles'.
