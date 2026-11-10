/** Stylesheet text imported with `?inline`, as the client bundle preset provides. */
declare module '*.css?inline' {
  const text: string
  export default text
}
