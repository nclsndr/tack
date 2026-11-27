import { Effect } from "effect";
import type { SkillChoice } from "../../domain/choices/choice-schema.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";
import type { LinkableKind } from "../../domain/resources/kinds.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter } from "../../services/state-store.ts";
import { userLinkedExcludes, userLinksOf } from "../reconciliation/linked-for-user.ts";
import { sourceQualifier } from "../sources/resource-reference.ts";
import { requireMutableChoice } from "./builtin-choice.ts";
import { ChoiceUserLinkedError, setSkillChoice } from "./choice.ts";

/**
 * The `tack` argv that excludes a resource for the user, from its source-qualified reference and
 * its kind. The caller names the command, as it does when it resolves a reference.
 */
export type UserExcludeCommand = (reference: string, kind: LinkableKind) => ReadonlyArray<string>;

/**
 * Refuses a project exclude that would hide nothing because the user namespace links the resource.
 * Its fix is the user exclude, named by source and kind.
 */
const requireVisibleExclude = Effect.fnUntraced(function* (
  catalog: Catalog,
  state: State,
  choice: SkillChoice,
  userExclude: UserExcludeCommand,
) {
  const [refused] = userLinkedExcludes(userLinksOf(state, catalog, false), [choice]);
  if (refused === undefined) return undefined;
  const { address, projectName } = refused;
  const command = userExclude(
    `${sourceQualifier(catalog, address.sourceRegistrationId)}:${address.name}`,
    address.kind,
  );
  return yield* new ChoiceUserLinkedError({
    code: "project-exclude-refused",
    address,
    projectName,
    message: `Project ${projectName} cannot hide ${address.kind} ${address.name}: the user namespace links it, so every agent in the project would still see it. Nothing was recorded. Run \`${argvLine(command)}\` to turn it off everywhere.`,
    next: [command],
  });
});

/**
 * Checks that a pick can be recorded against the current catalog and state: its resource is not
 * built in, and a project exclude still hides something. A batch runs it on every pick before its
 * first write.
 */
export const requirePickable = Effect.fnUntraced(function* (
  catalog: Catalog,
  state: State,
  choice: SkillChoice,
  userExclude: UserExcludeCommand,
) {
  yield* requireMutableChoice(catalog, choice.address);
  yield* requireVisibleExclude(catalog, state, choice, userExclude);
});

/** Records one pick in the writer's document once {@link requirePickable} accepts it. */
export const pickChoice = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  snapshot: { readonly catalog: Catalog; readonly state: State },
  choice: SkillChoice,
  userExclude: UserExcludeCommand,
) {
  yield* requirePickable(snapshot.catalog, snapshot.state, choice, userExclude);
  return yield* setSkillChoice(writer, choice);
});
