import { Effect } from "effect";
import type { Choice } from "../../domain/choices/choice-schema.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";
import type { LinkableKind } from "../../domain/resources/kinds.ts";
import type { Catalog } from "../../domain/sources/catalog-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";
import type { StateCheckpointWriter } from "../../services/state-store.ts";
import { userLinkedExcludes, userLinksOf } from "../reconciliation/linked-for-user.ts";
import { sourceQualifier } from "../sources/resource-reference.ts";
import { requireMutableChoice } from "./builtin-choice.ts";
import { ChoiceUserLinkedError, setChoice } from "./choice.ts";

/**
 * The `tack` argv that excludes a resource for the user, from its source-qualified reference and
 * its kind. The CLI builds it from its command model.
 */
export type UserExcludeCommand = (reference: string, kind: LinkableKind) => ReadonlyArray<string>;

/**
 * Refuses the first project exclude among `choices` that would hide nothing because the user
 * namespace links its resource. Its fix is the user exclude, named by source and kind.
 */
export const requireVisibleExcludes = Effect.fnUntraced(function* (
  catalog: Catalog,
  state: State,
  choices: ReadonlyArray<Choice>,
  userExclude: UserExcludeCommand,
) {
  const [refused] = userLinkedExcludes(userLinksOf(state, catalog, false), choices);
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
 * Records one pick in the writer's document, after the checks the catalog and state impose: the
 * resource is not built in, and a project exclude still hides something.
 */
export const pickChoice = Effect.fnUntraced(function* (
  writer: StateCheckpointWriter,
  catalog: Catalog,
  state: State,
  choice: Choice,
  userExclude: UserExcludeCommand,
) {
  yield* requireMutableChoice(catalog, choice.address);
  yield* requireVisibleExcludes(catalog, state, [choice], userExclude);
  return yield* setChoice(writer, choice);
});
