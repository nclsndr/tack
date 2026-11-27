# The path of one command

A command is one **tag** (`pick-include`, `state-clean`), and every part of it is keyed by that
tag. The tag spells the command path, so `tack pick include` is `pick-include`; a final `list` names
the group's bare command (`pick-list` is `tack pick`). Read `status` end to end as the example:
`cli/commands/status.ts`, its row in `cli/commands/declarations.ts`, `cli/routes/status.ts`,
`features/status/status.ts` and its view in `cli/human`.

## Steps to add a command

All paths are under `apps/cli/src`.

1. **Request.** Add the transport-free request to the `Invocation` union in `cli/commands/model.ts`,
   with the tag as `_tag`.
2. **Grammar.** Define the command in the family file of its first word in `cli/commands`
   (`pick.ts`, `state.ts`), building the request with `handle(tag, ...)`, and add it to
   `cli/commands/command-tree.ts`. Selector flags come from `cli/commands/target-selector.ts`.
3. **Declaration.** Add one row to `commandDeclarations` in `cli/commands/declarations.ts`: the
   schema of each payload slot it fills (`result`, `plan`, `applied`). The mode follows from the
   slots: a plan means preview and `--apply`, an applied payload alone an immediate write, a result
   alone a read. Declare `mode` only where that reading is wrong (`script-run`, `explore`, `init`),
   and `path` only where the tag's words cannot spell it. `stable: true` is a promise to automation;
   only the commands the `use-tack` skill names as stable carry it.
4. **Use case.** Put the behaviour in `features/<folder>` and return typed facts and typed failures.
   A preview-and-apply command runs through `previewOrApply` in `features/writer/recovered-writer.ts`.
5. **Route.** Add the route to the family file in `cli/routes` and spread its table into
   `cli/routes/index.ts`. It resolves `--cwd`, reads the snapshot, calls the use case and builds
   the outcome with the builders in `cli/envelope/outcomes.ts`, such as `resultAs(tag)` and
   `appliedAs(tag)`, which read the payload `kind` from the declaration. A new failure gets its
   public code in `cli/envelope/errors.ts`.
6. **View.** The host decodes each slot once with the declared schema and hands the view one
   `Option` per slot (`cli/human/render.ts`). Add a `HumanView<"your-tag">` to a family table and to
   `humanViews`. A view that declines a payload returns `undefined`, and the generic view shows it.
   `--json` prints the envelope itself; no view is involved.
7. **Help map.** Add the command to its row in `operationMap` (`cli/human/help-map.ts`) with its
   mode.
8. **Guidance.** Update the built-in skills and the README, as the `maintain-tack` skill says.

## What fails when a step is missing

| Missing or wrong                                          | Caught by                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration row                                           | Compiler: `commandDeclarations` `satisfies` a record over every tag                                                                                              |
| Route                                                     | Compiler: `routes` is `RoutesFor<Invocation["_tag"]>`; `test/cli-host-routes.unit.test.ts`                                                                       |
| View                                                      | Compiler: `humanViews` `satisfies HumanViews`, a mapped type over the tags                                                                                       |
| A view reading the wrong payload type                     | Compiler: `HumanView<Tag>` receives `DeclaredPayload<Tag, Slot>`                                                                                                 |
| The tag's path does not parse to the tag                  | `test/cli-parser.unit.test.ts`, whose operand table is itself checked over every tag                                                                             |
| Manifest and declarations disagree                        | `test/cli-discovery.unit.test.ts`                                                                                                                                |
| Help map mode differs from the declared one               | `test/help-map.unit.test.ts`                                                                                                                                     |
| A payload its schema does not decode                      | `test/payload-declarations.unit.test.ts` over the captured envelopes, and every `--json` run in the in-process host runner (`test/support/declared-payloads.ts`) |
| A view that overflows 40, 80 or 120 columns or leaks ANSI | `cli/human/render.test.ts`                                                                                                                                       |
| A skill that names a removed command or flag              | `test/guidance-commands.repo.test.ts`                                                                                                                            |

Subprocess runs are not decoded against the declarations, and no test catches a wrong sentence in a
help text or a skill: run the command.

## Rules of thumb

- A route is transport. When a route grows a branch about Tack's rules, that branch belongs in the
  use case, so the explorer and the command cannot drift apart.
- The explorer stages changes the operator could type as commands, and runs the same use case
  checks on its batch before the first write (`features/choices/pick.ts` is the model).
- A text view is not a contract and may change. A stable `--json` payload is one: any change to it
  is a breaking change, listed in the pull request.
