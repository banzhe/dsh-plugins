import { clientBundle } from '@banzhe/dsh-devkit'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-file-link-open'

export default clientBundle({
  id,
  // The browser half is one file at the package root.
  clientEntry: 'src/client.tsx',
})
