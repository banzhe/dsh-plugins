/**
 * The build seam for `x.module.css` imports.
 *
 * The client bundle resolves the import through the CSS Modules plugin in
 * `tsdown.config.ts`, which compiles the sheet and exports its class map as
 * the default. Without this declaration `tsc --noEmit` treats the import as
 * an untyped module.
 */
declare module '*.module.css' {
  const classes: Record<string, string | undefined>
  export default classes
}
