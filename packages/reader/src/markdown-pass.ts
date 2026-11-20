/**
 * Whether this render is Rspress's Markdown pass (SSG-MD), the one that writes a page's Markdown
 * twin, `llms.txt` and `llms-full.txt`. Rspress replaces `import.meta.env.SSG_MD` at compile time,
 * and that pass renders with a client reconciler in Node: no `window`, but React reads client
 * snapshots. Figures use this to print their text instead of a drawing.
 */
export function markdownPass(): boolean {
  return import.meta.env.SSG_MD === true;
}
