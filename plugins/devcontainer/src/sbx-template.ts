/**
 * The image a Docker Sandbox is created with, as one argv token.
 *
 * The rule is shared by three callers that cannot reach each other's modules: the
 * row schema that validates the setting, the settings page in the browser that
 * writes it, and the argv builder that hands it to `sbx`. It therefore lives in a
 * module of its own — no Node import — so all three read one definition instead of
 * three copies.
 * @module @banzhe/dsh-devcontainer/sbx-template
 */

/**
 * What a configured image may look like: nothing at all, or one argv token with
 * no whitespace of its own and no leading `-`.
 *
 * Surrounding whitespace is tolerated and trimmed, because the value is a person's
 * typing and the token is what reaches the CLI. A leading `-` is not, because the
 * CLI would read the value as another flag, and neither is an inner space, which
 * `sbx` would split into two arguments.
 */
export const SANDBOX_TEMPLATE_PATTERN = /^\s*(?:[^\s-]\S*)?\s*$/u

/**
 * The image one configured value names, trimmed, or undefined when it names none.
 * @param value - the configured `sbxTemplate`.
 * @returns the image to pass as `--template`, or undefined for the CLI's own template.
 * @throws Error when the value cannot travel as one argv token.
 */
export function sandboxTemplateOf(value: string): string | undefined {
  if (!SANDBOX_TEMPLATE_PATTERN.test(value)) {
    throw new Error(`sbx: sbxTemplate ${JSON.stringify(value)} cannot be passed as one image name: it must contain no whitespace and must not start with "-"`)
  }
  const image = value.trim()
  return image === '' ? undefined : image
}
