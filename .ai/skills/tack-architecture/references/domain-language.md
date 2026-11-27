# Domain language

`CONTEXT.md` at the repository root is the glossary, and it wins. Each term there has a definition
and the words to avoid. Code takes the same word, so a reader can go from a sentence in the glossary
to the type that holds it. Add or change the glossary entry in the same commit as the code that
introduces the concept.

## Terms that steer the code

Each term is in the glossary except the resolved selector, which only the code names.

| Term              | In code                                                                                      | Do not confuse with                           |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Selector          | `Selector` in `domain/projects/project-schema.ts`: bare, `--project`, `--user`, `--all`      | a target or a namespace                       |
| Resolved selector | `ResolvedSelector`, beside it: a bare selector after the working directory chose its project | the requested selector, which `--json` echoes |
| Namespace         | `Namespace` in `domain/choices/choice-schema.ts`: one project or the user                    | a source or a root                            |
| Target            | One resolved destination within a selector's scope (`ManagedLinkTarget`, `RunTarget`)        | a selector                                    |
| Choice            | `Choice`, beside `Namespace`: a stored include or exclude of one resource                    | activation                                    |
| Pick              | The CLI word for a choice: `tack pick`, and the use case `pickChoice`                        | a second concept; a pick is a choice          |

A word the operator types names the code that serves it: the tag `pick-include`, the family files
`cli/commands/pick.ts` and `cli/routes/pick.ts`, the use case in `features/choices`. When the CLI
word and the glossary word differ, as pick and choice do, the glossary records both and says they
are one thing.

## How much domain-driven design

Tack is a small CLI with one process and one state file. It borrows the parts of domain-driven
design that pay for themselves here, and stops there.

Adopted:

- **One language.** The glossary, the code, the help text and the skills use the same words.
- **Cohesive folders.** `domain` and `features` are folders of one concept each, with an acyclic
  import graph. A cycle is a misplaced file.
- **Use cases.** A feature function owns a rule, whoever calls it: the route, the explorer, or
  another feature.
- **Typed facts at the edge.** Schemas decode every value read from disk or from a payload, and a
  use case returns facts that the CLI words.
- **One composition root.** `bootstrap` alone picks live implementations.

Left out on purpose:

- Aggregates, repositories and domain events as named patterns. The state document is read through
  the command snapshot and changed only through the state store's mutations under its lock, which
  already gives one consistency boundary.
- Entity classes. Data is an Effect `Schema` and behaviour is a function over it.
- A service per entity or a generic file service. A service exists only to replace an external
  action in tests, choose an implementation, or share a lifecycle.
- Bounded contexts as packages. The layers and folders inside `apps/cli` are enough at this size.

When a change seems to need one of these, write down the problem it solves in the pull request and
check it against [decisions.md](decisions.md) first.
