---
name: tack-architecture
description: Where code goes in the Tack CLI - its layers, the path of one command, the domain language and the decisions behind them. Use before adding a command, feature or domain concept to `apps/cli`, or moving code between layers.
---

# Tack CLI architecture

`apps/cli/src` is six layers, lowest first. A module imports only its own layer and the layers its
row allows; `apps/cli/test/architecture-boundaries.repo.test.ts` enforces every rule here.

| Layer       | Holds                                                                                | May import                       |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `domain`    | Schemas, identities, policy and plans: what is stored or two features share. No I/O. | `domain`                         |
| `services`  | The tag and interface of each injected capability                                    | `domain`                         |
| `platform`  | Live implementations of services over files, Git, processes, the reader              | `domain`, `services`             |
| `features`  | Use cases that drive services and domain policy                                      | `domain`, `services`             |
| `cli`       | From argv to the public envelope and its text view                                   | `domain`, `services`, `features` |
| `bootstrap` | The composition root: builds the live layers once                                    | everything                       |

`platform` and `features` are siblings and never import each other. Inside `cli`, the folders
`commands`, `envelope`, `human`, `explorer`, `routes` and `host` follow the same rule, in that order.

## Where new code goes

- **A command**: one tag, one declaration, one route, one view. Follow
  [references/command-lifecycle.md](references/command-lifecycle.md) step by step; the compiler
  names most of what is missing.
- **Behaviour a command performs**: a use case in `features/<folder>`, called by the route and by
  the explorer when it offers the same change. The route keeps only transport: reading flags and
  input, wording diagnostics, encoding the outcome.
- **A domain concept**: its word in `CONTEXT.md` first, then the same word in code. Read
  [references/domain-language.md](references/domain-language.md) before naming a type or a folder.
- **A schema**: in `domain` when the state file stores it or two features share it, otherwise beside
  the feature that produces it.
- **A capability a test must replace**: a small service in `services`, its live layer in
  `platform`, supplied once by `bootstrap`. Pure policy stays a plain function in `domain`.
- **A move between layers or folders**: run the boundary test after each move; it names the import
  or the cycle that breaks the order.

## Before you restructure

Read [references/decisions.md](references/decisions.md): it says why the current shape was chosen,
which restructurings were weighed and declined, and what the code deliberately leaves alone. For
each import rule and the test that asserts it, read [references/layers.md](references/layers.md).
