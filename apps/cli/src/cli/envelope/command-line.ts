import type { commandDeclarations } from "../commands/declarations.ts";
import { commandPathOf } from "../commands/model.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";
import type { UserExcludeCommand } from "../../features/choices/pick.ts";

/** An operation a printed command can name: every invocation the command tree declares. */
export type CommandName = keyof typeof commandDeclarations;

/**
 * The argv that runs one operation: `tack`, its command path from the command model, then the given
 * operands and flags.
 */
export const invocation = (
  command: CommandName,
  ...words: ReadonlyArray<string>
): ReadonlyArray<string> => ["tack", ...commandPathOf(command), ...words];

/**
 * The `tack` command line that runs one operation: its command path from the command model, then
 * the given operands and flags, each quoted only when the shell would split it.
 */
export const commandLine = (command: CommandName, ...words: ReadonlyArray<string>): string =>
  argvLine(invocation(command, ...words));

/**
 * The flags that select the same place again: `--project NAME` for anything that names a project
 * (a selector, a choice namespace or a link target), `--user`, `--all`, or none for a bare selector.
 */
export const selectorFlags = (selector: {
  readonly _tag: string;
  readonly projectName?: string;
}): ReadonlyArray<string> =>
  selector.projectName !== undefined
    ? ["--project", selector.projectName]
    : selector._tag === "user"
      ? ["--user"]
      : selector._tag === "all"
        ? ["--all"]
        : [];

/**
 * The user exclude that turns a resource off everywhere: the fix that a refused project exclude and
 * the `project-exclude-linked-for-user` warning name.
 */
export const userExcludeCommand: UserExcludeCommand = (reference, kind) =>
  invocation("pick-exclude", reference, "--kind", kind, "--user");
