import type { ShellCompletion } from "./demo-shell.ts";

/**
 * The choices Tab listed, and which one is selected (`-1` for none yet), as in zsh's menu
 * completion: Tab and Shift+Tab move the selection and write it into the line.
 */
export type CompletionMenu = {
  /** The line before the word being completed. */
  readonly head: string;
  /** The line as Tab left it when the menu opened, restored when nothing is selected. */
  readonly typed: string;
  readonly options: ShellCompletion["options"];
  readonly index: number;
};

/** The menu over a completion that offered several choices; nothing is selected yet. */
export const openMenu = (completion: ShellCompletion): CompletionMenu => ({
  head: completion.head,
  typed: completion.line,
  options: completion.options,
  index: -1,
});

/** Moves the selection by `delta`, wrapping around; the first move from none picks an end. */
export const moveMenu = (menu: CompletionMenu, delta: 1 | -1): CompletionMenu => {
  const count = menu.options.length;
  const index =
    menu.index === -1 ? (delta === 1 ? 0 : count - 1) : (menu.index + delta + count) % count;
  return { ...menu, index };
};

/** The line with the selected choice written in, or as typed when nothing is selected. */
export const menuLine = (menu: CompletionMenu) => {
  const selected = menu.options[menu.index];
  return selected === undefined ? menu.typed : `${menu.head}${selected.value}`;
};

/** The line once the selection is accepted: a space follows it, except after a folder. */
export const acceptMenu = (menu: CompletionMenu) => {
  const selected = menu.options[menu.index];
  if (selected === undefined) return menu.typed;
  return `${menuLine(menu)}${selected.value.endsWith("/") ? "" : " "}`;
};
