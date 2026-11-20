/** Build flags that Rspress replaces at compile time. */
interface ImportMetaEnv {
  /** True while Rspress renders a page to Markdown (SSG-MD), false in the HTML and the browser. */
  readonly SSG_MD: boolean;
}
