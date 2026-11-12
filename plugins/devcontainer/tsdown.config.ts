import { clientBundle } from '@banzhe/dsh-devkit'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-devcontainer'

export default clientBundle({
  id,
  node: {
    // The container runs `shell.ts` and `fs.ts` as separate programs beside the
    // plugin entry, so this half ships three entries.
    entry: { index: 'src/index.ts', shell: 'src/shell.ts', fs: 'src/fs.ts' },
    clean: true,
    // The container runs this program with its own `node`, so it ships verbatim
    // next to the bundles instead of being compiled with them.
    copy: [{ from: 'src/helper/main.mjs', to: 'lib/helper' }],
  },
})
