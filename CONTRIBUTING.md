# Contributing to Tack

This guide covers working on Tack itself: setup, checks, tests, branches and pull requests, and where
each kind of documentation lives. To install and use Tack, read the [README](README.md).

## Set up a checkout

Tack is a Bun and Effect monorepo. Use the Bun version that `packageManager` declares in
[package.json](package.json), then install the dependencies from the lockfile:

```sh
bun install --frozen-lockfile
```

The workspaces are `apps/cli` (the `tack` executable), `apps/website` (the landing page and public
docs), `packages/core` (the script API and runner), `packages/reader` (the docs reader and search),
`packages/harness` (the agent prompts the website and evals share), `scripts` (build, release and
maintenance scripts) and `evals` (Docker-only agent evals, a private workspace that releases never
include).

The repository's own agent skills live in `.ai/skills`. Link them into `.claude/skills`,
`.agents/skills`, `.cursor/skills` and `.opencode/skills` with `bun run ai:init`, and remove those
links with `bun run ai:reset`. Run `ai:init` again after you add or rename a skill. The root
`tack.yaml` also declares these skills, so Tack can deliver them instead: [AGENTS.md](AGENTS.md)
gives the steps.

## Run your changes

Run the checkout's CLI from source with `bun tack`. When you test Tack itself, give every run a
throwaway home and state directory, so that it never reads or changes your real `~/.tack` or agent
folders:

```sh
scratch=$(mktemp -d)
HOME="$scratch" bun tack --state-dir "$scratch/state" state init
HOME="$scratch" bun tack --state-dir "$scratch/state" catalog
```

To install a checkout as the global `tack`, run `bun run install:local` in it. On a clean `main` it
fast-forwards from `origin` first. It then builds the npm package, packs it and installs the tarball
with `npm install --global`, exactly as npm users get it. `npm_config_prefix` selects another global
prefix. The script is for maintainers and is not part of the package.

## Checks

`bun run check` runs the format check, lint, type check and every test suite. CI runs these gates
on each pull request, together with dead-code detection, the website build, the coverage budget and
runtime and package gates. It skips the release, runtime and package gates when a pull request
changes only `evals/` or `apps/website/`. It does not run on `main` after a merge; run it there from
the Actions tab when needed. CI is the source of truth. Narrower commands:

| Command                        | What it does                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `bun run format`               | Formats the files `format:check` covers. `bun run format:check` only reports.             |
| `bun run lint`                 | Runs `oxlint` with type-aware rules. `bun run lint:fix` applies the safe fixes.           |
| `bun run typecheck`            | Type-checks every workspace and the evals.                                                |
| `bun run deadcode`             | Runs `knip`: unused files, exports, types and dependencies. CI runs it; `check` does not. |
| `bun run test:unit`            | Runs the Vitest suites, except the release system tests.                                  |
| `bun --bun vitest run FILE...` | Runs the named test files.                                                                |
| `bun run test:release`         | Runs the release system tests.                                                            |
| `bun run test:eval`            | Runs the eval container script tests with `bun test`.                                     |
| `bun run test:coverage`        | Runs the unit suites with coverage and enforces the coverage budget.                      |
| `bun run website:build`        | Builds the website. CI runs it; `bun run website:dev` serves it locally.                  |

Run `deadcode` after you delete or move files or exports, or change dependencies.

## Tests

Write the test first, watch it fail, then make it pass. The `repo-code-quality` skill in
[.ai/skills](.ai/skills/repo-code-quality/SKILL.md) holds the full rules for code and tests.

- Name a test file in `apps/cli/test` after the behavior it tests and its level:
  `.system.test.ts` spawns the CLI, `.host.test.ts` runs the host or a feature in-process,
  `.unit.test.ts` touches neither, and `.repo.test.ts` checks repository files. A test beside its
  module in `src` keeps the plain `.test.ts`.
- Shared test helpers live in `apps/cli/test/support/`, or in a `*.test-support.ts` file beside the
  module they serve.
- Keep `bun run test` free of warnings.

Coverage is an uncovered-items budget: `maxUncovered` in [vitest.config.mts](vitest.config.mts) caps
the statements, branches, functions and lines of production source that may stay uncovered. CI's
`coverage` job fails when a count goes over it. A change that lowers an uncovered count lowers the
matching number by the same amount. Raising a number needs a stated reason in the pull request.

A change to the CLI, the source format or the reader's figure components also updates the built-in
skills in the same pull request. The `maintain-tack` skill in
[.ai/skills](.ai/skills/maintain-tack/SKILL.md) names what to update and how to compare it.

## Versions

Every package shares one plain SemVer `0.y.z` version, set by hand: run
`bun run version:set <0.y.z | patch | minor>` to write it into the four manifests and `bun.lock`,
then commit the diff. `y` marks a breaking contract change or a notable feature and `z` anything
else; a new commit needs no bump. `bun run check` fails when a manifest or the lock disagrees.

## Branches, commits and pull requests

- Name a branch `<type>/<short-name>`, such as `fix/sync-preview`. CI's `static` job enforces
  `^(feat|fix|refactor|perf|test|docs|ci|build|chore|revert)/[a-z0-9._-]+$`.
- Write commit messages and pull request titles as
  [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, such as
  `fix(cli): ...` or `docs: ...`. Mark a breaking change with `!`, such as `feat(cli)!: ...`.
- Keep history linear. Update a branch with `git rebase` or `git pull --rebase`, and never create a
  merge commit. Pull requests land on `main` as a squash or a fast-forward.
- Open the pull request against `main`. Fill in the sections of the
  [template](.github/pull_request_template.md): **Why** (the need, in plain words), **What** (the
  change at a glance), **Related to** (issues and pull requests, or "none") and **Details** (design
  notes, tests run, risks and follow-ups).
- A pull request is ready when every CI job is green.

## Where documentation lives

| Path                           | Content                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `README.md`                    | What Tack is, how to install it, and links to the guides.                                   |
| `apps/cli/README.md`           | The CLI guide: setup, sources, selection, sync, docs, scripts and the automation contract.  |
| `packages/reader/README.md`    | The reader author guide: docs resources, configuration and customization.                   |
| `packages/core/README.md`      | The script API and runner.                                                                  |
| `apps/website`                 | The landing page and public docs; its [README](apps/website/README.md) explains the layout. |
| `apps/cli/src/builtins/skills` | The built-in skills that ship with Tack and teach agents to use it.                         |
| `.ai/skills`                   | Skills for agents that work on this repository.                                             |
| `CONTEXT.md`                   | The domain glossary.                                                                        |
| `AGENTS.md`                    | The project instructions every agent session loads.                                         |

## Security

Do not report a vulnerability in a public issue or pull request. Follow [SECURITY.md](SECURITY.md).
