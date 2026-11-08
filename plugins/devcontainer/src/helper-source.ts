/**
 * The container-side helper program, as text.
 *
 * The source ships as a plain \`.mjs\` next to the bundled rows because the
 * container runs it with its own \`node\` — nothing in this repository compiles it.
 * Both layouts resolve through the same relative path: \`src/helper/main.mjs\`
 * while running from source, and \`lib/helper/main.mjs\` in the built package.
 * @module @banzhe/dsh-devcontainer/helper-source
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the helper program lives inside the container. */
export const HELPER_CONTAINER_PATH = '/tmp/.dsh-devcontainer/helper.mjs'

/** The container directory the helper is staged in. */
export const HELPER_CONTAINER_DIRECTORY = '/tmp/.dsh-devcontainer'

let cached: string | undefined

/**
 * The absolute path of the helper program on this host.
 * @returns the path of the shipped \`main.mjs\`.
 */
export function helperSourcePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'helper', 'main.mjs')
}

/**
 * Read the helper program that is staged into the container.
 * @returns the program text, read once per process.
 * @throws Error naming the missing path when the packaged file is absent.
 */
export function helperSource(): string {
  if (cached !== undefined) return cached
  const path = helperSourcePath()
  try {
    cached = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`devcontainer: cannot read the container helper at "${path}"; reinstall the bundle`, { cause: error })
  }
  return cached
}
