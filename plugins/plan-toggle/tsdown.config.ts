import { clientBundle } from '@banzhe/dsh-devkit'

/** Must match package.json `name`; the ModuleLoader factory id is this string. */
const id = '@banzhe/dsh-plan-toggle'

export default clientBundle({
  id,
})
