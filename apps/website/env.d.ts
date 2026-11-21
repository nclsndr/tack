/** Build flags that Rspress replaces at compile time. */
interface ImportMetaEnv {
  /** True while Rspress renders a page to Markdown (SSG-MD), false in the HTML and the browser. */
  readonly SSG_MD: boolean;
}

/** A real terminal capture, imported as its text with the `?raw` query. */
declare module "*.ansi?raw" {
  const text: string;
  export default text;
}
