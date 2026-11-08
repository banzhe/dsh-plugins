/**
 * Just enough JSONC for `devcontainer.json`: the Dev Container specification
 * allows `//` and `/* *\/` comments plus trailing commas, and no shipped parser
 * accepts them. Stripping happens string-aware, so a `//` inside a value (a URL,
 * a shell fragment) survives.
 * @module @banzhe/dsh-devcontainer/jsonc
 */

/** Copy one double-quoted literal starting at `start`, honoring escapes. */
function stringEnd(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === '\\') {
      index += 2
      continue
    }
    index += 1
    if (character === '"') return index
  }
  return text.length
}

/** Remove comments and trailing commas so strict `JSON.parse` accepts the text. */
export function stripJsonComments(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    const next = text[index + 1]
    if (character === '"') {
      const end = stringEnd(text, index)
      out += text.slice(index, end)
      index = end
      continue
    }
    if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += character
    index += 1
  }
  return stripTrailingCommas(out)
}

/** Drop commas that are followed only by whitespace and a closing bracket. */
function stripTrailingCommas(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const character = text.charAt(index)
    if (character === '"') {
      const end = stringEnd(text, index)
      out += text.slice(index, end)
      index = end
      continue
    }
    if (character === ',') {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead] as string)) lookahead += 1
      const closing = text[lookahead]
      if (closing === '}' || closing === ']') {
        index += 1
        continue
      }
    }
    out += character
    index += 1
  }
  return out
}

/**
 * Parse one JSONC document (a leading BOM is tolerated).
 * @param text - the file content.
 * @returns the parsed value.
 * @throws SyntaxError when the document is not valid JSONC.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, '')))
}
