import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";
import type { ChoiceNamespace } from "../../domain/choices/choice-schema.ts";
import { ProjectNameSchema } from "../../domain/projects/project-schema.ts";
import type { TargetSelector } from "../../domain/projects/project-schema.ts";
import { booleanFlag, optionalFlag, optionalStringFlag } from "./flag-utils.ts";
import { invalid } from "./invocation-receiver.ts";
import type { InvocationIssue } from "./model.ts";

type SelectorOptions = {
  readonly projectName: typeof ProjectNameSchema.Type | undefined;
  readonly user: boolean;
  readonly all?: boolean;
  readonly cwd?: string | undefined;
};

/** Current-directory override used by target-aware command families. */
export const cwdFlag = optionalStringFlag("cwd", "Resolve the target from this directory");
/** Project selector flag. */
export const projectFlag = optionalFlag(
  Flag.String("project").pipe(Flag.withSchema(ProjectNameSchema)),
  "Select a registered project",
);
/** User selector flag. */
export const userFlag = booleanFlag("user", "Select the user namespace");
/** Machine-wide selector flag. */
export const allFlag = booleanFlag("all", "Select every project and the user target");

/** Selects one named project, or the bare current-directory scope when no project is named. */
const projectSelectorOf = (
  projectName: string | undefined,
): Extract<TargetSelector, { readonly _tag: "bare" | "project" }> =>
  projectName === undefined ? { _tag: "bare" } : { _tag: "project", projectName };

/**
 * Picks the target named by selector flags without rejecting conflicts; `--user` takes precedence
 * over `--project`. Use {@link selectorFrom} unless the command records conflicts itself.
 */
export const selectorOf = (options: SelectorOptions): TargetSelector =>
  options.user === true
    ? { _tag: "user" }
    : options.all === true
      ? { _tag: "all" }
      : projectSelectorOf(options.projectName);

/** Translates selector flags into one target selector. */
export const selectorFrom = (
  options: SelectorOptions,
): Effect.Effect<TargetSelector, InvocationIssue> =>
  Number(options.user === true) +
    Number(options.all === true) +
    Number(options.projectName !== undefined) >
  1
    ? invalid("invalid-selector", "Choose at most one of --project, --user and --all.")
    : options.cwd !== undefined &&
        (options.user || options.all === true || options.projectName !== undefined)
      ? invalid("invalid-selector", "--cwd can only be used with a bare selector.")
      : Effect.succeed(selectorOf(options));

export function namespaceFrom(
  options: SelectorOptions,
  required: true,
): Effect.Effect<ChoiceNamespace, InvocationIssue>;
export function namespaceFrom(
  options: SelectorOptions,
  required: false,
): Effect.Effect<ChoiceNamespace | undefined, InvocationIssue>;
/** Translates selector flags into one optional or required choice namespace. */
export function namespaceFrom(
  options: SelectorOptions,
  required: boolean,
): Effect.Effect<ChoiceNamespace | undefined, InvocationIssue> {
  return selectorFrom(options).pipe(
    Effect.flatMap((selector) => {
      if (selector._tag === "project" || selector._tag === "user") return Effect.succeed(selector);
      return required === true
        ? invalid("invalid-selector", "Choose exactly one namespace with --project or --user.")
        : Effect.succeed(undefined);
    }),
  );
}
