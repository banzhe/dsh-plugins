/**
 * The build seam for `x.css?inline` imports.
 *
 * The client bundle resolves such an import through the inline-CSS plugin in
 * `tsdown.config.ts` and hands back the stylesheet's text as a default string.
 * Without this declaration `tsc --noEmit` would treat the import as an untyped
 * module.
 */
declare module '*.css?inline' {
  const css: string
  export default css
}
