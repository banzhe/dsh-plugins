/**
 * The build seam for `x.css?inline` imports.
 *
 * The client bundle resolves such an import through the shared devkit's inline
 * CSS plugin and hands back the stylesheet's text as a default string.
 */
declare module '*.css?inline' {
  const css: string
  export default css
}
