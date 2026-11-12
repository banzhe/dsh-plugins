import { clientBundle } from '@banzhe/dsh-devkit'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-agent-preset-visibility'

export default clientBundle({
  id,
})
