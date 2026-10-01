/**
 * The build seam for `x.css?inline` imports.
 *
 * Both consumers hand back the stylesheet's text as a default string: the
 * client bundle resolves it through the inline-CSS plugin in
 * `tsdown.config.ts`, and the specs resolve it through Vite's own `?inline`
 * handling. Without this declaration `tsc --noEmit` would treat the import as
 * an untyped module.
 */
declare module '*.css?inline' {
  const css: string
  export default css
}
