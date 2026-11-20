import type { PostCSSOptions } from "@rsbuild/core";

/**
 * Wraps the final PostCSS options so the reader stylesheet is processed by the reader plugins
 * alone, while every other stylesheet keeps the worktree's PostCSS configuration.
 *
 * @param worktree - The options Rsbuild resolved from the worktree's PostCSS configuration.
 * @returns Loader options flagged `config: false`, which postcss-loader reads from the function
 * itself before calling it.
 */
export function isolateReaderStylesheet<Context extends { resourcePath: string }>(
  worktree: PostCSSOptions | ((context: Context) => PostCSSOptions) | undefined,
  stylesheet: string,
  plugins: NonNullable<PostCSSOptions["plugins"]>,
): ((context: Context) => PostCSSOptions) & { config: false } {
  const options = (context: Context): PostCSSOptions => {
    if (context.resourcePath === stylesheet) return { plugins, config: false };
    if (typeof worktree === "function") return worktree(context);
    return worktree ?? {};
  };
  return Object.assign(options, { config: false as const });
}
