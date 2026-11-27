---
name: maintain-tack
description: Keep the built-in skills in step with the code. Use before opening a PR that changes the Tack CLI (commands, flags, aliases, output, diagnostic codes, adapters, release or upgrade) the source format (tack.yaml, discovery, skill metadata, dependencies) or the reader's figure components, when writing tests or fixing a test warning, and when naming a new package; names what to update and compare.
---

# Maintain Tack's guidance

Tack ships five built-in skills in `apps/cli/src/builtins/skills`. Agents on every machine load them
to operate Tack and to author sources, and nothing else tells them what changed. A skill left behind
makes agents run removed flags, miss new rules and teach operators behavior that is gone.
**Change the skills in the same PR as the behavior.** A PR that alters what a skill describes is not
done until the skill says the new thing.

## What to update

| File                                                                             | Owns                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/builtins/skills/author-tack-profiles/SKILL.md`                     | Profile files, source linkage, independent copy operations, fixed application and bundle behavior.                                                                                                                |
| `apps/cli/src/builtins/skills/author-tack-profiles/references/copy-workflows.md` | What `profile save`, `profile adopt` and `profile apply` each write, with worked commands.                                                                                                                        |
| `apps/cli/src/builtins/skills/author-tack-profiles/references/bundles.md`        | Profile bundles: `bundle-support`, export, inspect, check and apply, integrity and retention.                                                                                                                     |
| `apps/cli/src/builtins/skills/use-tack/SKILL.md`                                 | Finding resources, the executable, state and scope, preview and apply, the stable JSON contract.                                                                                                                  |
| `apps/cli/src/builtins/skills/use-tack/references/operations.md`                 | Setup, picks, sync, adapters, docs, scripts, upgrade, cleanup, exit codes.                                                                                                                                        |
| `apps/cli/src/builtins/skills/use-tack/references/onboarding.md`                 | First-time setup that `tack guide onboarding` prints: mode, depth, approvals, the setup steps, hand-over. Printed guides take no relative links; name `tack guide TOPIC` instead.                                 |
| `apps/cli/src/builtins/skills/use-tack/references/day-two.md`                    | The commands for a new project, worktree, clone, source, skill, script or docs after setup.                                                                                                                       |
| `apps/cli/src/builtins/skills/use-tack/references/agent-instructions.md`         | The Tack section for a project's `AGENTS.md`: when to offer it, which file gets it, its exact text.                                                                                                               |
| `apps/cli/src/builtins/skills/manage-tack-sources/SKILL.md`                      | The source `tack.yaml`, resource names and metadata, dependencies, name clashes, catalog issue fixes.                                                                                                             |
| `apps/cli/src/builtins/skills/manage-tack-sources/references/tack-yaml.md`       | Every `tack.yaml` key and version, declared paths, patterns and `profiles` publications.                                                                                                                          |
| `apps/cli/src/builtins/skills/manage-tack-sources/references/metadata.md`        | Resource metadata keys and where a `depends-on` edge resolves.                                                                                                                                                    |
| `apps/cli/src/builtins/skills/manage-tack-sources/references/worked-source.md`   | Complete source layout, patterns, scripts, docs, resource dependencies and name-clash fixes.                                                                                                                      |
| `apps/cli/src/builtins/skills/manage-tack-sources/references/scripts.md`         | Writing a script with `defineScript`: arguments, secrets, the run context, outcome codes and dependencies.                                                                                                        |
| `apps/cli/src/builtins/skills/prepare-tack-checkout/SKILL.md`                    | Linking a repository's skills at the start of work in a new clone or worktree, and the approval its section gives.                                                                                                |
| `apps/cli/src/builtins/skills/write-reader-figures/SKILL.md`                     | Writing figures in docs: when to draw, which component, the rules, `tack check`. Update it with the reader's figure catalog. Its `references/figure-components.md` is generated: run `bun run figures:reference`. |
| `apps/cli/README.md`, `packages/*/README.md`, `CONTEXT.md`                       | Operator and author documentation, and the glossary. Skills summarize them; they must agree.                                                                                                                      |

The built-in `tack.yaml` (`apps/cli/src/builtins/tack.yaml`) declares the built-in skills. Add a
skill there only on purpose: every built-in skill is installed for the user by default.

## What to compare

Run these against your change and read the code, not the skill, to decide what is true.

| If the change touches…                                        | Compare with…                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A command, subcommand, flag, alias or default                 | `bun tack --help` and `bun tack PATH... --help`, and the operation map in `cli/human/help-map.ts`. Aliases such as `list` and `ls` are not in the map: read `cli/commands/list-alias.ts`.  |
| Which flags combine, which selector a command needs           | The command's handler in `apps/cli/src/cli/commands` and its route. A flag that "requires" another is a claim to test.                                                                          |
| JSON payloads, `kind` names, stable commands                  | The payload schemas in `domain/*/*-schema.ts` and `cli/commands/manifest.ts`. Only `status`, `sync`, `init`, `doctor`, `upgrade` (with `upgrade status`) and `--version` are stable.            |
| Human output, `--format`, color, `next`                       | Skills teach the text view and its `Next` block. Say that text views are unstable and not to be parsed.                                                                                         |
| Diagnostic or quarantine codes                                | The string literals in `apps/cli/src` and `README.md`. Codes are kebab-case; script run outcome codes are snake_case.                                                                           |
| Docs conflict reasons, mounts, search                         | `features/docs`, `docs-links.ts`, and the `use-tack` code list. Update all names, not one.                                                                                                      |
| Adapters, delivery paths, which kinds an adapter links        | `domain/agents/agent-adapter.ts` and the adapter table in `operations.md`.                                                                                                                      |
| Source format: keys, paths, patterns, names, overlap          | `domain/sources/source-schema.ts`, `resource-declarations.ts`, `declared-path.ts`, `docs-discovery.ts`.                                                                                         |
| Skill or command metadata, activation, dependency rules       | `resource-frontmatter.ts`, `features/choices`, and the metadata section of `manage-tack-sources`.                                                                                               |
| Source or project health, `doctor` checks                     | `features/doctor`, `source-schema.ts` warnings, and the catalog issue table in `manage-tack-sources`.                                                                                           |
| Profiles, fixed profile application, the `profile` commands   | `domain/profiles`, `features/profiles/profile-*.ts`, `cli/commands/profiles.ts`, and both `author-tack-profiles` files.                                                                         |
| Profile bundles: format, export, check, apply, retention      | `domain/bundles`, `features/profiles/bundle-*.ts`, and `author-tack-profiles/references/bundles.md`.                                                                                            |
| Install, upgrade, release, state format, built-in skills      | `domain/self/upgrade-guide.ts`, `release.ts` (built-in copies), `apps/cli/README.md`, and the install and upgrade parts of both `use-tack` files.                                               |
| Script API or declaration                                     | `packages/core/src/script-api.ts`, `script-api-adapter.ts`, `resource-declarations.ts`, `scripts.md`, and the script parts of both skills. After an API change, run `bun run script-api:types`. |
| A figure component, its props, its budget or the figure check | `packages/reader/src/figures/reference.ts` (the contracts the skill's reference is generated from) and the `write-reader-figures` decision table.                                               |

## Procedure

1. List what the change makes true, false or new for an agent or an author. Include removed behavior:
   deleted flags, renamed codes, retired layouts.
2. Search the files above for every name involved: `grep -rn "NAME" apps/cli/src/builtins .ai/skills
apps/cli/README.md CONTEXT.md`. Fix each hit, and add what is new where the skill that owns the
   topic teaches it.
3. Exercise the claim, do not trust the prose. Use a throwaway `HOME` and an explicit
   `--state-dir` under `mktemp -d`, a source built from the skill's own example, and run the command
   the skill tells an agent to run. Never use the real `~/.tack`.
4. Run `bun --bun vitest run apps/cli/test/guidance-commands.repo.test.ts apps/cli/test/guidance-drift.repo.test.ts`.
   Extend the checks when the change adds something a test can derive: a new adapter, a new
   declaration key or code is picked up automatically; a new family of codes needs its prefix in
   `scripts/guidance-drift.ts`.
5. Run `bun run check`, then re-read the diff of the skills as an agent who has only that text.

## What the tests catch, and what they do not

- `guidance-commands.repo.test.ts` fails when a skill names a command or flag the executable no longer
  has, a diagnostic code the code no longer defines, a stable-JSON set that changed, an adapter
  directory that moved, or a declaration key or quarantine code the source skill does not mention.
- `guidance-drift.repo.test.ts` fails when guidance teaches a resource tier Tack removed, or the
  retired folder-based source layout.
- `guidance-commands.repo.test.ts` decodes fenced `version: 1` declarations from guides and skill
  references with the real source, resource-entry and docs-entry decoders. It also parses worked
  skill frontmatter and metadata examples. Keep examples fenced as `yaml` or `markdown` so the
  tests find them. The worked-source reference must retain its three declarations.
- `guidance-drift.repo.test.ts` also rejects retired resource groupings and source labels in guidance.
- Neither catches a wrong sentence. "Requires `--project`", "plans only docs mounts", "context is
  selected by default" are behavior claims: read the handler and run the command.

## Writing rules for the skills

- Tack commands in a skill carry no `--json`: agents read the text view, and `--json` is for exact state
  fields or a structured answer (stable payloads: `status`, `sync`, `init`, `doctor`, `upgrade`, `--version`). Preview before `--apply`, and say which commands
  change state immediately.
- Describe what Tack does now. Skills ship with the package the operator installed, so they
  describe that version: no retired layout, removed flag or future release.
- Describe resources by source, kind and name. `maintainers` is descriptive contact information;
  it grants no permissions and defines no resource grouping. Filesystem link ownership and
  repository visibility are separate concepts.
- Keep complex worked examples in references and link them from the compact skill. Pair
  `depends-on` with resource metadata, and show how to resolve each name clash the example creates.
- Keep a fact in the skill that owns it and name that skill from the others. The source format
  belongs to `manage-tack-sources`; operating Tack belongs to `use-tack`.
- Keep the operator's machine, paths outside `$HOME/.local` and `~/.tack`, and people (other than as
  an example of `maintainers`) out of the skills.
- When code and a skill disagree and the code looks wrong, report the bug in the PR and keep the
  skill true to the shipped behavior.

## Package names

Every package in this repository uses the npm organization `@tackup`, published or private: the CLI
publishes as `@tackup/cli`, its workspace name, and the private workspace packages are
`@tackup/core`, `@tackup/reader`, `@tackup/harness`, `@tackup/website`, `@tackup/scripts` and
`@tackup/evals`. Name a new package `@tackup/<name>`.

## Writing tests

- Name a file in `apps/cli/test` after the behavior it tests and its level: `.system.test.ts`
  spawns the CLI, `.host.test.ts` runs the host or a feature in-process on live layers,
  `.unit.test.ts` touches neither, and `.repo.test.ts` checks repository files. A test of another
  level goes to a file of that level. Never name a file after a project phase. A test beside its
  module in `src` keeps the plain `.test.ts`.
- Keep `bun run test` warning-free. Fix each new stderr warning at its root cause; the fix is never
  stderr filtering, console suppression, a longer timeout or a global sleep.
- Treat a warning as a possible product bug: a missing `Drawer.Viewport` once broke swipe-to-close
  and touch scroll on mobile. A product fix ships with a regression test that goes red without it.
- Test a text view beside it in `apps/cli/src/cli/human/`, on the helpers of
  `human.test-support.ts`. `render.test.ts` holds every operation to the view contract (fits 40, 80
  and 120 columns, no ANSI without color); a view test passes its long or wide samples to
  `expectViewContract` instead of checking widths or escapes itself.
- Settle async React state in reader tests with `waitForReact` from
  `packages/reader/src/react.test-support.ts`.
- Navigate in jsdom with cancelable clicks (`{ bubbles: true, cancelable: true }`) and route fixture
  pages through the mocked router, as `packages/reader/src/runtime.browser.test.ts` does.
- Prefer in-process tests (jsdom or node) over a headless browser. CLI tests run with a throwaway
  `HOME`, `XDG_*` and `TMPDIR` under `mktemp -d`, as `apps/cli/test/reader-shutdown.system.test.ts`
  does.
- A full-suite failure on a loaded machine is a regression only once the failing files also fail
  alone with one worker (`bun --bun vitest run --no-file-parallelism FILE...`). CI is the source of
  truth.
- A PR that adds or changes tests reports its CI time against a recent green `main` run.
