import { Effect } from "effect";
import { GitOutputParseError, type GitWorktree } from "../../services/git.ts";

const worktreeCommand = "git worktree list --porcelain -z";

const parseWorktreeRecord = Effect.fnUntraced(function* (record: ReadonlyArray<string>) {
  const first = record[0];
  if (first === undefined || first.startsWith("worktree ") === false) {
    return yield* new GitOutputParseError({
      command: worktreeCommand,
      message: "A worktree record must begin with a worktree path.",
    });
  }

  const attributes = yield* Effect.forEach(record, (attribute) => {
    const separator = attribute.indexOf(" ");
    const label = separator === -1 ? attribute : attribute.slice(0, separator);
    const value = separator === -1 ? undefined : attribute.slice(separator + 1);

    if (label.length === 0 || (label === "worktree" && separator === -1)) {
      return Effect.fail(
        new GitOutputParseError({
          command: worktreeCommand,
          message: "A worktree attribute is malformed.",
        }),
      );
    }

    return Effect.succeed({ label, value });
  });

  const labels = attributes.map((attribute) => attribute.label);
  if (new Set(labels).size !== labels.length) {
    return yield* new GitOutputParseError({
      command: worktreeCommand,
      message: "A worktree record contains duplicate attributes.",
    });
  }

  const path = attributes.find((attribute) => attribute.label === "worktree")?.value;
  if (path === undefined || path.length === 0) {
    return yield* new GitOutputParseError({
      command: worktreeCommand,
      message: "A worktree record has no path.",
    });
  }

  const booleanAttribute = (label: string) =>
    attributes.some((attribute) => attribute.label === label);
  const valueAttribute = (label: string) =>
    attributes.find((attribute) => attribute.label === label)?.value;
  const branch = valueAttribute("branch");
  const locked = booleanAttribute("locked") ? (valueAttribute("locked") ?? "") : undefined;
  const prunable = booleanAttribute("prunable") ? (valueAttribute("prunable") ?? "") : undefined;

  return {
    bare: booleanAttribute("bare"),
    detached: booleanAttribute("detached"),
    path,
    ...(branch === undefined ? {} : { branch }),
    ...(locked === undefined ? {} : { locked }),
    ...(prunable === undefined ? {} : { prunable }),
  } satisfies GitWorktree;
});

/** Parses Git's NUL-terminated porcelain worktree output. */
export const parseGitWorktreeList = Effect.fnUntraced(function* (output: string) {
  if (output.length === 0) {
    return [] as ReadonlyArray<GitWorktree>;
  }

  if (output.endsWith("\0") === false) {
    return yield* new GitOutputParseError({
      command: worktreeCommand,
      message: "Git worktree output is not NUL terminated.",
    });
  }

  const tokenState = output.split("\0").reduce<{
    readonly current: ReadonlyArray<string>;
    readonly records: ReadonlyArray<ReadonlyArray<string>>;
  }>((state, token) => (token === "" ? (state.current.length === 0 ? state : { current: [], records: [...state.records, state.current] }) : { current: [...state.current, token], records: state.records }), { current: [], records: [] });

  return yield* Effect.forEach(tokenState.records, (record) => parseWorktreeRecord(record));
});
