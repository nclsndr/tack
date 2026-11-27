# CI

`ci.yml` runs on every pull request into `main`, and on demand from the Actions tab. It does not run on
pushes to `main`: each pull request already ran CI on its merge with `main`.

## Jobs

```text
changes ──┬── static ─────────┐
          ├── test (1..4/4) ──┼── coverage
          └── gates ──────────┘
```

| Job        | What it runs                                                                                                        | When it runs                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `changes`  | The branch-name check, then `scripts/ci-scope.ts`, which sets the `suite` and `gates` outputs                       | Always                                                             |
| `static`   | `format:check`, then `lint`, `typecheck`, `deadcode`, `website:build` and `test:eval`, or only `test:repo`           | Always. Only `format:check` and `test:repo` when `suite` is false  |
| `test`     | `test:unit` with coverage, split into 4 shards. Each shard uploads a coverage blob                                  | When `suite` is not false                                          |
| `gates`    | The release test, then the runtime gates (Node, Bun) and the package gates (Node 24, Bun, Node 22.13) on one runner | When `gates` is not false                                          |
| `coverage` | Fails if another job failed or was cancelled, then merges the shard blobs and checks the uncovered budget           | Always, unless the run was cancelled. Skips the merge without `suite` |

`changes` takes about 6 seconds and needs no `bun install`. The other jobs wait for it so that they
can skip before starting a runner.

## Scope

`scripts/ci-scope.ts` diffs the pull request's merge commit against its first parent, the base
branch, and classifies the changed files:

| Changed files                                                      | `suite` | `gates` | What runs                                                            |
| ------------------------------------------------------------------ | ------- | ------- | -------------------------------------------------------------------- |
| Guidance documents only                                            | false   | false   | `changes`, `static` (`format:check` and `test:repo`), `coverage`     |
| Only `evals/`, `apps/website/` and guidance documents               | true    | false   | Everything except `gates`                                            |
| Anything else, no changed file, or a manual run                    | true    | true    | Everything                                                           |

The guidance documents are `AGENTS.md`, `CONTRIBUTING.md`, `CONTEXT.md`, `README.md`, `SECURITY.md`,
`STRATEGY.md`, `.github/pull_request_template.md`, this file and everything under `.ai/`. A path matches
only at that exact place: `apps/cli/README.md` or `packages/core/AGENTS.md` runs everything.

They do not skip every check: `test:repo` (the `apps/cli/test/*.repo.test.ts` files) checks that
the guides and skills name only real commands and flags and use current wording. That is why a
guidance-only pull request still runs it in `static`.

## Why `coverage` is the only required check

`main`'s ruleset requires `coverage` alone. It waits for every other job and fails when any of them
failed or was cancelled. A job skipped by its `if:` counts as passed. So one required check covers
the whole run, and a new or renamed job needs no ruleset change.

Do not add `paths` or `paths-ignore` to the trigger. A workflow that does not start never reports
`coverage`, and the pull request can never merge. Skip work inside the run instead, through `changes`.

## Changing the skip set

1. Find what reads the path before adding it: `git grep` its name across tests, `scripts/`,
   `package.json` scripts, `knip.json`, the website config and the package build. A path that a
   test, build, package or workflow reads stays out of the set, unless the guidance-only path runs
   that reader too, as it runs `test:repo`.
2. Add a case to `scripts/ci-scope.test.ts` first and watch it fail, then add the path to
   `guidanceFiles` or `guidanceFolders` in `scripts/ci-scope.ts`.
3. Keep anything you are unsure about out of the set: running more is safe, skipping a reader is
   not.
4. A pull request that changes `ci.yml` or `ci-scope.ts` runs everything, so it does not exercise
   the skip. To see the skip, push a throwaway base branch that has the change and lists itself in
   `pull_request.branches`, then open a guidance-only pull request against it.
