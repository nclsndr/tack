# Tack CLI

Tack manages cross-agent resources: skills, commands, context, docs, and scripts. This guide covers
CLI setup, source registration, resource selection and installation, project docs, and supervised
script execution. See the [contributing guide](../../CONTRIBUTING.md) for development commands and the
[reader author guide](../../packages/reader/README.md) for document configuration and customization.

## Adapters

The current adapters are Claude Code (`claude`), Cline (`cline`), Codex (`codex`), GitHub Copilot
CLI (`copilot`), Cursor (`cursor`), Gemini CLI (`gemini`), OpenCode (`opencode`) and Pi (`pi`). Tack
links skills to these directories:

| Adapter    | User                        | Project root       |
| ---------- | --------------------------- | ------------------ |
| `claude`   | `~/.claude/skills`          | `.claude/skills`   |
| `cline`    | `~/.cline/skills`           | `.cline/skills`    |
| `codex`    | `~/.agents/skills`          | `.agents/skills`   |
| `copilot`  | `~/.copilot/skills`         | `.github/skills`   |
| `cursor`   | `~/.cursor/skills`          | `.cursor/skills`   |
| `gemini`   | `~/.gemini/skills`          | `.gemini/skills`   |
| `opencode` | `~/.config/opencode/skills` | `.opencode/skills` |
| `pi`       | `~/.pi/agent/skills`        | `.pi/skills`       |

Cline, Cursor, OpenCode and Pi also link selected command files, as `<name>.md`, to these
directories. Claude Code, Codex, Copilot CLI and Gemini CLI currently deliver skills only: Copilot
CLI reads Markdown commands only from Claude Code's `.claude/commands`, and Gemini CLI reads
commands only as TOML files.

| Adapter    | User                          | Project root            |
| ---------- | ----------------------------- | ----------------------- |
| `cline`    | `~/Documents/Cline/Workflows` | `.clinerules/workflows` |
| `cursor`   | `~/.cursor/commands`          | `.cursor/commands`      |
| `opencode` | `~/.config/opencode/commands` | `.opencode/commands`    |
| `pi`       | `~/.pi/agent/prompts`         | `.pi/prompts`           |

Pi calls a command a prompt template and Cline a workflow. Tack links the original Markdown file and
does not translate it, so arguments and frontmatter mean what each agent makes of them. Cline runs a
linked command as `/<name>.md`, extension included, and the sync preview says so. Tack uses these
standard folders only: it does not follow `XDG_CONFIG_HOME` or `OPENCODE_CONFIG_DIR` for OpenCode,
`PI_CODING_AGENT_DIR` for Pi, `COPILOT_HOME` for Copilot CLI, `GEMINI_CLI_HOME` for Gemini CLI or
`CLINE_DIR` for Cline. Pi reads the project's `.pi` folders from the folder it starts in, so start
it at the project root, and it loads project resources only after you trust the project.
Several agents also read another agent's folder: OpenCode reads `.claude/skills` and
`.agents/skills`; Pi, Gemini CLI and Copilot CLI read `.agents/skills`; Copilot CLI and Cline also
read `.claude/skills`. A skill that the `claude` or `codex` adapter links can then show up twice.
Disabling one adapter removes only its own links, so the agent can still see the skill through
another one. An open agent session can need a restart, or `/reload` in Pi, to see a new link.

### Agents reached through a shared folder

These agents have no adapter, but their own docs or source say they read skills from a folder an
adapter already fills: `.agents/skills` from the `codex` adapter, or `.claude/skills` from the
`claude` adapter. They get skills only; commands reach an agent only through its own adapter.
"Project and user" means the agent reads the project folder and the one in your home.

| Agent                                                                                                                | Folder           | Reads it at                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| [Amp](https://ampcode.com/docs/markdown/customize/skills)                                                            | `.agents/skills` | Project and user, also `.claude/skills`                              |
| [Antigravity](https://antigravity.google/docs/skills.md)                                                             | `.agents/skills` | Project only                                                         |
| [Auggie](https://docs.augmentcode.com/cli/skills.md)                                                                 | `.agents/skills` | Project and user, also `.claude/skills`                              |
| [Continue](https://github.com/continuedev/continue/blob/main/extensions/cli/src/util/loadMarkdownSkills.ts)          | `.claude/skills` | Project only                                                         |
| [Crush](https://github.com/charmbracelet/crush#agent-skills)                                                         | `.agents/skills` | Project and user, also `.claude/skills`                              |
| [Devin CLI and Devin Desktop (Windsurf)](https://docs.devin.ai/cli/extensibility/skills/overview.md)                 | `.agents/skills` | Project and user                                                     |
| [Factory Droid](https://docs.factory.com/harness/skills.md)                                                          | `.agents/skills` | Project and user                                                     |
| [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/using-skills.md) | `.agents/skills` | Project and user, also `.claude/skills`                              |
| [Grok Build](https://docs.x.ai/build/features/skills-plugins-marketplaces)                                           | `.agents/skills` | User only                                                            |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)    | `.agents/skills` | Project only, after `hermes skills trust`                            |
| [Junie](https://junie.jetbrains.com/docs/agent-skills.html)                                                          | `.agents/skills` | Project and user, project in a trusted project                       |
| [Kilo Code](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/skills.md)             | `.agents/skills` | User only, Kilo refuses project links that point outside the project |
| [Letta Code](https://github.com/letta-ai/letta-code/blob/main/src/agent/skills.ts)                                   | `.agents/skills` | Project only                                                         |
| [Mistral Vibe](https://docs.mistral.ai/vibe/code/cli/skills)                                                         | `.agents/skills` | Project and user, project in a trusted folder                        |
| [OpenClaw](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md)                                      | `.agents/skills` | Project and user                                                     |
| [OpenHands](https://docs.openhands.dev/overview/skills.md)                                                           | `.agents/skills` | Project and user                                                     |
| [Qwen Code](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/skills.md)                             | `.agents/skills` | Project and user                                                     |
| [Warp](https://docs.warp.dev/agents/capabilities/skills/)                                                            | `.agents/skills` | Project and user, also `.claude/skills`                              |
| [Zed](https://zed.dev/docs/ai/skills.md)                                                                             | `.agents/skills` | Project and user, project in a trusted worktree                      |

The features page on the website shows the same list. Vendors move these folders often: re-read an
agent's docs before relying on one.

Enable adapters as shown below. `tack sync --adapter claude --user --apply` limits one sync to an
enabled adapter; sync refuses an adapter that is not enabled and names `tack adapter enable`.

## Run it

After [installing Tack](../../README.md#install), set up the machine. `tack init` writes at once and
has no `--apply`:

```sh
tack init
```

It plans the whole setup, then applies it:

1. **State.** It creates the state and its `.env` when they are absent and keeps them otherwise. A
   state this release cannot read fails the command before anything is planned.
2. **Agents.** It enables the agents whose home folder exists: `claude` from `~/.claude`, `cline`
   from `~/.cline` or `~/Documents/Cline`, `codex` from `~/.codex` or `~/.agents`, `copilot` from
   `~/.copilot`, `cursor` from `~/.cursor`, `gemini` from `~/.gemini`, `opencode` from
   `~/.config/opencode`, `pi` from `~/.pi`. The output lists each one as found or
   not found. `--adapter ID`, repeatable, names the agents instead. It only adds adapters and never
   disables one.
3. **User links.** It applies the plan `tack sync --user` makes once those agents are enabled. On a
   new machine that links the built-in skills; after an upgrade it points them at the new version.
4. **Hand-made entries.** It lists the files, folders and links in those agents' user skill and
   command folders that Tack has no record of, and leaves them untouched. One at a built-in skill's
   path is that link's `foreign-destination` conflict; everything else still applies.

It creates the state when absent, then plans and, under one writer lock, enables the agents and
applies the user sync. It prints what it created, enabled, linked and removed, with every link
action. It never touches sources, projects or picks. On a machine that is set up it writes nothing
and says so, so `tack init` is also the one step after an upgrade. With no agent home found and no
`--adapter`, it sets up the state only and is partial with `agent-home-not-found`. Its `Next` names
what to run; on a first run, `tack guide onboarding` comes first. Its `--json` payloads are stable:
an `init-plan`, whose `user` is the `sync-plan` of `sync --user`, and an `init-application`, whose
`user` is the `sync-application`.

The examples below use the installed `tack`. A Tack checkout runs as `bun run --cwd <checkout> tack`,
with an isolated state directory when testing Tack itself. Read the text views when operating Tack.
Use `--json` when structured fields are needed.

Tack stores its state in `~/.tack` by default. Set `TACK_STATE_DIR`, or put `--state-dir <path>` before the command, to use another location. The explicit command flag takes precedence over `TACK_STATE_DIR`.
The state directory must be on a local machine. Writer lock recovery uses process IDs and does not support a home directory shared across machines.

```sh
tack --state-dir ./local-tack-state state init
```

`tack --version` prints the running version. It takes no command and combines only with `--json`
and `--state-dir`; it works before `init` and reads no state. `tack --help` lists it with the
other root flags.

`state init` creates the state directory, a `state.json` file, and an operator-owned `.env` file,
and nothing else; `init` runs it first. It does not overwrite existing state or `.env` files.

### Guides for agents

`tack guide onboarding` prints the onboarding guide of the running version: how an agent sets up
Tack on a machine with a person, or unattended, asking before each change. It is the same Markdown
the built-in `use-tack` skill reads, printed byte for byte after a header that names the version.
`tack guide` lists every guide: `onboarding`, `agent-instructions` (the Tack section for a project's
`AGENTS.md`) and `day-two` (what to run for a new project, worktree, source or skill). It needs no
state and writes nothing, so it works before `tack init`. An unknown topic fails with
`guide-topic-unknown` and the list of guides.

## Built-in skills and global selection

Tack includes a built-in source, labelled `tack`, with five skills: `use-tack`, for operating Tack,
`manage-tack-sources`, for creating and maintaining a source, `author-tack-profiles`, for fixed
manifest authoring and checks, `write-reader-figures`, for writing figures in docs, and
`prepare-tack-checkout`, which links a repository's skills at the start of work in a new clone or
worktree. `catalog` and `source` report
this source without a manual registration; its resources have `origin: "builtin"`, resources
from sources a profile bundle provides have `origin: "bundle"`, and resources from other registered
sources have `origin: "registered"`.

The source belongs to the running Tack. An npm package copies it once per version into
`~/.tack/builtins/<version>/`, so agent links never point into npm's folder, which npm may replace.
`TACK_BUILTINS_DIR` moves that folder; `--state-dir` and `TACK_STATE_DIR` never do, so several
states share the copies. A checkout uses its own `apps/cli/src/builtins`. Agent directories hold
symbolic links to those files, not copies or operator registrations.

Built-in skills are always delivered at user scope: `tack sync --user --apply` links each one once
per user into the user skill directory of every enabled adapter, such as `~/.claude/skills`. Tack
needs them to work, so they cannot be opted out, and no pick or setting removes them. After an
upgrade, the next sync, or `tack init`, relinks them to the new version's copy. When a package run applies a sync, it
then removes the copies under `~/.tack/builtins` that are neither the running version, nor the newest
older one, nor the target of a link in the user home or a registered project root of that state.
The newest older copy stays for another state that still links it, until that state syncs.

Each agent decides when to load the instructions. Project reconciliation does not install another
copy by default. Built-in skills are locked in `tack explore`, at both user and project scope.
`pick include`, `pick exclude` and `pick remove` refuse built-in references with
`builtin-skill-locked`.

Selection defaults and dependency rules are defined under [skill metadata](#skill-metadata).
Project choices remain independent for registered resources.

A missing built-in source or malformed skill produces normal source/catalog health diagnostics. A
registered source that provides a skill with the same name as a built-in skill is a name clash, not
a quarantine: both stay healthy, and you name the built-in one with the `tack` label, such as `tack:use-tack`.
Source registration cannot adopt the built-in source, and relocation cannot change its location.

## Upgrade Tack

Tack never upgrades itself: the package manager that installed it does. `tack upgrade` and
`tack --json upgrade status` report the same thing, without network and without changing anything:
the running version, how Tack was installed (`npm`, `bun` or `source`) and the command that
upgrades it. `tack --version` prints the running version alone.

| Installed with | `command`                                 |
| -------------- | ----------------------------------------- |
| npm            | `npm install --global @tackup/cli@latest` |
| Bun            | `bun add --global @tackup/cli@latest`     |
| A checkout     | none: pull it and run `bun install`       |

After a package upgrade, run `tack init` to point the built-in skills at the new version. For a
package install, `tack upgrade` names both commands under `Next`.

## Attach source-owned documents

Register the source and project before opening or searching docs. A source declaration can be as
small as:

```yaml
version: 1
docs:
  - name: handbook
    path: knowledge
```

`path` names any directory inside the source. A docs resource is identified by its source and its
name, so the same name in different sources stays distinct. For optional `docs serve` settings,
Markdown, MDX, metadata, and components, see the
[reader author guide](../../packages/reader/README.md#authoring-a-docs-resource).

After `source add` and `project add`, attach the resource by name. Write `source:name`, with the
source's label or registration ID, only when several registered sources declare that name:

```sh
tack docs attach handbook --project demo
tack docs attach product-docs:handbook --project demo   # only when another source also has "handbook"
tack docs configure --project demo --default handbook
tack sync --no-adapters --project demo
tack sync --no-adapters --project demo --apply
tack docs --project demo
tack docs target --project demo
```

Attach, detach, and configure persist local intent. `sync --no-adapters` previews link changes;
`--apply` writes them. Every active worktree of the project gets a separate relative symlink at
`.tack/docs/SOURCE_ID/NAME`. All mounts refer to the same registered source checkout.
`tack docs configure --project demo --destination knowledge` changes the relative destination base;
run reconciliation afterward to move the owned links. Existing directories and untracked symlinks
are conflicts and are never adopted or overwritten.

The default writing resource is local to the project. `docs target` returns its physical source
folder and verified managed mount. Choose another attached resource with
`--name REFERENCE`, using `source:name` when the name is ambiguous. The command refuses an absent, redirected, or
unmanaged mount. Agents and editors create or modify documents through that mount. Tack does not
create documents, change their lifecycle, or manage their Git history.

Detach with `tack docs detach handbook --project demo`, then reconcile with
`--apply`. Detaching the writing default clears it. `configure --clear-default` also clears it.
Cleanup removes only verified owned links and preserves source content. Project and root removal
and reset include docs mounts. A mount that cannot be removed safely (the destination was replaced,
a parent is no longer an ordinary directory, or the unlink failed) stays on disk as a pending
removal with its cause and last result, exactly like an agent link: the removal finishes, `status`,
`sync` and `doctor` report the obligation, and `state clean --pending` retries it. Project refresh previews and updates docs mounts for changed worktrees in its
`docs` field; a docs conflict after the roots change is reported as a partial result with the
applied changes. Source relocation keeps its registration ID; reconcile docs afterward to update
the mounts.

## Read attached documents

```sh
tack docs serve --project demo
tack docs serve --cwd /path/to/registered/worktree --no-open --port 0
tack docs serve --project demo --open
```

The reader requires initialized Tack state, a registered project, and registered sources for its
attachments. `--cwd` defaults to the current directory; `--project` selects a registered project
explicitly. The reader combines attached resources in one project view with separate source-qualified roots and shared search.

The command stays in the foreground until Ctrl+C. A browser opens by default only at an
interactive terminal: stdin and stdout are terminals, `TERM` is set and not `dumb`, `CI` is unset,
and no coding-agent marker is present. `--open` opens one anyway and `--no-open` never does; the
two flags conflict. `--port` selects the port, and `0` requests an available one. A successful startup emits one readiness
envelope with `result: { kind: "reader-session", url, project: { name, root } }`. Engine diagnostics use stderr. Ctrl+C
closes the watcher and server without another envelope. An unexpected engine stop reports on
stderr and exits with code `1`.

## Search attached documents

```sh
tack docs search "source ownership" --project demo --limit 5
tack docs search "selection" --cwd /path/to/worktree --type spec --status active --tag skills
```

Search uses the same registered resources and loading rules as the browser, without starting a
server. It accepts `--project`, `--cwd`, `--type`, `--status`, `--tag`, and `--limit`. Viewer-only
`--port` and `--no-open` are rejected. Query terms use case-insensitive AND matching across saved
content and paths. Metadata filters are exact. The default limit is 10; valid limits are 1 through 50. The query must contain text and has a maximum length of 512 characters.

The public envelope uses `command: "docs search"`. Its result has `kind: "reader-search"` and includes `project`, `complete`,
`issues`, `query`, `limit`, `total`, `truncated`, and bounded `hits`. A project with no attached
docs is an incomplete setup: `complete` is `false` and a `setup` object names the
`no-docs-attached` gap and the `tack docs attach` command that closes it. Each document hit identifies
its source registration, source path, docs name, physical file, resource-relative path,
title, route, and metadata. Matching blocks include saved-file versions, physical source line
ranges, contributors, and excerpts. A hit has at most three blocks and each excerpt has at most
400 characters. Full source is not returned. Inspect cited files before editing.

Failures are isolated. A malformed document yields its own `document-load` issue with its `path`
and cause while every healthy sibling in the same resource stays searchable. An invalid
resource-level reader configuration yields one `resource-load` issue and makes only that resource
unavailable. Either way `complete` is `false`. Search reads plain Markdown and never compiles
custom render modules, so a broken component does not hide a hit; `tack docs serve` still reports it.
`docs` reports the same corpus: attachments, the searchable `documents` count, `mounts` with
their health, `complete`, and the same `setup` gap.
`complete: false`, resource-addressed issues, and the partial envelope classification explicitly
report that limitation, including for zero hits. Complete zero-match searches succeed with exit
code `0`. Invalid invocations or missing registration use exit `2`; partial results use exit `1`.
Reader and search never infer unregistered folders.

## Check authored content

Write files, run `tack check PATH...`, and repeat until clean:

```sh
tack check /sources/tools /sources/helpers
tack check /sources/tools/profiles/ci.yaml /sources/helpers
tack check docs/architecture.mdx docs /artifacts/ci.tar.gz
```

Each path is detected as a source folder (or its tack.yaml), a profile YAML file, a content bundle,
or Markdown docs. A source includes declaration/resource validation, the dependency edges of its
skills and commands, its published profiles and its docs figures. An edge that names no single
resource is reported at its line: `dependency-missing`, `dependency-quarantined`,
`dependency-source-undeclared` and `dependency-ambiguous` are errors, or warnings on an optional
edge. An edge that resolves nowhere in the check while a declared source is missing from it is the
warning `dependency-source-unchecked`, which names that source, and while a passed source cannot be
read it is `dependency-source-unhealthy`. An edge that resolves is not checked against a source
missing from the check, which could still make it ambiguous at `sync`.
Source/profile linkage and dependency edges use only source folders included in this invocation,
plus release-owned built-ins. Pass companion sources together; check never reads operator state,
fetches a source, initializes registrations or executes authored code. Direct profile files need
an owning version-2 source publication.

One combined report gives file:line findings and observed inventories. Overlapping paths are
checked once. Errors exit 1, warnings exit 0; an unavailable input is `check-path-unavailable` and
an unsupported file is `check-path-unsupported`. The unversioned JSON `check-report` has checks,
findings and counts derived from those findings. It is not a stable automation payload.

Docs use the reader's static figure rules and, as the reader does, skip dot, underscore and
`node_modules` entries and the folders of another source.
`figure-issues` is an error; runtime-computed props produce `figure-not-checked` warnings. No page
or supplied component runs. Docs validation includes icons and author components through the reader’s static validator.
`profile inspect-bundle` remains an inventory read-out; `tack check` validates a bundle's complete
archive, integrity facts and actual projected profile meaning.

It also checks every `<Icon name="...">` of the `.mdx` files against the reader's docs icon set and
prints each unknown one by line with the closest names in the set, or Lucide's current name for an
old one. An unknown icon produces an `icon-unknown` finding with its file and line, and exits `1`. Find a name with the lookup:

```sh
tack docs icons database
tack docs icons
```

`docs icons` needs no project. It lists the docs icon set by category with the Lucide version it
comes from; a word keeps the icons whose name or old Lucide name contains it, or whose category has
it as a word. The result has `kind: "docs-icons"` with `query`, `lucideVersion`, `count` and
`categories`. A word that matches nothing is a `docs-icons-none` warning.

The check also reads the author components `Callout`, `Tabs`, `Tab` and `Term` and prints each
misuse by line: an unknown `kind`, a `Tab` without a label, outside `Tabs` or labelled twice, `Tabs`
with fewer than two tabs, a `Term` without `title`. Each misuse produces a `component-issue` finding with its file and line, and exits `1`.

## Register sources

A source contains a root `tack.yaml` declaring version 1 or 2. Version 2 adds profile publications
and explicit bundle support. That file is the only thing that
puts resources in the catalog: it lists where each kind of resource lives, anywhere inside the
source. Tack reads nothing by convention, so a folder named `skills/` means nothing until a
declaration names it. A source is the only grouping of resources. A resource is identified by its
source, its kind, and its name; nothing else in the layout changes that identity. To create or
change a source with an agent, use the built-in `manage-tack-sources` skill.

```yaml
version: 1
name: quality-tools
maintainers:
  - docs-contact
depends-on:
  - base-skills
skills:
  - path: skills # a declared folder: every skill below it
    exclude: ["**/_*/**"] # skip archived and work-in-progress folders
  - path: vendor/skills # a second declared folder
  - path: labs/one-off # a folder that holds SKILL.md is one skill
commands:
  - path: commands
  - path: prompts/review.md # one command
context:
  - path: context
    include: ["**/*.md"]
scripts:
  - name: report
    path: tools/report.ts
    description: Generate the report.
docs:
  - name: handbook
    path: knowledge
```

| Key              | Meaning                                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | The source label: up to 64 characters of lowercase letters, digits and single hyphens, never shaped like a registration ID. Operators and other sources write it as `quality-tools:review`. `tack` is reserved for the built-in source; generated `bundle-` labels are reserved for artifact projections. |
| `maintainers`    | A list of descriptive contacts. Tack shows it in `source` and `catalog` and never interprets it: it does not affect identity, selection, delivery, dependencies or editing.                                                                                                                               |
| `depends-on`     | Labels of the sources whose resources this source's resources may depend on.                                                                                                                                                                                                                              |
| `skills`         | Entries with a `path` to a folder, or to one skill, and optional `include` and `exclude` patterns. Every folder below a declared folder that holds `SKILL.md` is a skill.                                                                                                                                 |
| `commands`       | Entries with a `path` to a folder or one `.md` file, and optional patterns. Every `.md` file below a declared folder is a command.                                                                                                                                                                        |
| `context`        | Entries with a `path` to a folder or one file, and optional patterns. Every regular file below a declared folder is a context item.                                                                                                                                                                       |
| `scripts`        | Entries with a `name`, a `path` to one `.ts` file and a `description`.                                                                                                                                                                                                                                    |
| `profiles`       | Version-2 `{ name, path }` publications of independently versioned fixed profiles.                                                                                                                                                                                                                        |
| `bundle-support` | Version-2 explicit support files/directories, complete closure and non-secret runtime prerequisites per resource.                                                                                                                                                                                         |
| `docs`           | [Declared documentation](#attach-source-owned-documents). Names are unique within the source. Reader settings are in the [reader author guide](../../packages/reader/README.md#authoring-a-docs-resource).                                                                                                |

Each resource key is an optional list, and an empty list such as `skills: []` is valid. An unknown
top-level key makes the source unhealthy; a bad entry is quarantined alone and the rest of the
source keeps working. The five resource keys are decoded one entry at a time, so a typo in one
entry never hides the others.

### Collections

A folder that holds only skill folders, only `.md` commands, or only docs can declare itself as a
**collection**: a `tack.yaml` with `version: 1`, a `kind` and no resource keys. The folder that holds
it is the collection.

```yaml
version: 1
kind: skills
```

| `kind`     | What the source holds                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `skills`   | Each folder at its top that holds `SKILL.md`. Nothing deeper is read.                                            |
| `commands` | Each `.md` file at its top whose name is a command name; `README.md` and other names are ignored.                |
| `docs`     | The whole folder, as one docs resource named by the required `name`, which is also the label. `reader` tunes it. |

Names that start with `.` or `_` are never resources. A collection takes `name`, `maintainers`,
`depends-on` (skills and commands) and `reader` (docs); no resource keys, patterns or profiles.
Context and scripts need the list form. A collection declares nothing else, so other content beside
it is a source of its own with its own `tack.yaml`. A skills collection holds skills only: each
folder at its top is a skill. `tack source add --skills .` and `tack check` name each folder there
that holds no `SKILL.md` in the warning `collection-folder-not-skill`, and Tack ignores it; the
warning changes no exit code. Dot, underscore and `node_modules` folders and folders with their own
`tack.yaml` are not named. A skills collection whose folder holds
`SKILL.md` is one skill, and the source is unhealthy with `source-is-one-skill`; `kind: skill` is
refused. `tack import add --into SOURCE` writes into a skills collection's top; `SOURCE:FOLDER` is
refused. `tack source` shows its one declaration as `(collection)`, and `catalog --details` says
`skills collection` where a list-form resource says `declared by skills: PATH`.

Without a `name`, the label is the registered directory's base name when that is a valid label.
That fallback is local to one machine, so a source that other sources depend on should declare its
`name`. Two registered sources with one label cannot qualify a reference until one changes; each
stays reachable by registration ID. Labels are typed, never stored: state, picks, docs mount paths,
reader routes and run history use the registration ID.

**Declared paths.** Every `path`, docs included, is non-empty, relative and `/`-separated, with no
`.`, `..`, empty segment or backslash. It resolves, after symlinks, to a place inside the source
and exists with the right type: a folder for `skills`, a folder or file for `commands` and
`context`, a `.ts` file for `scripts`, a folder for `docs`. A declared path may be a symlink to a
place inside the source. Everything found inside a declared folder must resolve inside that folder,
or it is refused with `resource-boundary-violation`; to use content elsewhere in the source,
declare that path. Declarations of skills, commands, context and scripts may not overlap, so each
file belongs to at most one declaration: equal or nested paths overlap, a profile publication
counts as a file entry, and only an `exclude` on the outer folder entry that prunes the inner path
ends an overlap. Docs paths are exempt. A declaration that breaks a rule is
quarantined with its own reason code (`declaration-entry-invalid`, `declaration-path-invalid`,
`declaration-path-outside-source`, `declaration-path-missing`, `declaration-path-wrong-type`,
`declaration-path-overlap`, `declaration-reaches-source`) and the other entries still load.

**Nested sources.** Each `tack.yaml` marks the edge of a source, as a nested repository does in
Git. Below a source's root, a folder that holds `tack.yaml` and no `SKILL.md` belongs to another
source, registered or not, and the parent never reads it; configurations never merge or inherit.
A declared path of any kind that is or lies inside such a folder is refused with
`declaration-reaches-source`. A skills, commands or context folder whose walk meets one skips that
folder and reports it with the same code; `exclude: ["vendor/**"]` on the entry says the nesting
is intended. A docs folder passes over another source without a finding. A `tack.yaml` inside a
skill folder is the skill's content.

**Names.** A skill is named by its own folder, which must match the frontmatter `name` and a
description. A command is named by its file name without `.md`. A context item is named by its
path relative to the declared folder, including its extension, so `context/notes.md` is `notes.md`;
a single declared file is named by its file name. A script is named by its declared `name`.
Group folders never change a name. Two resources of one kind and name in one source are both
quarantined, whichever declarations found them.

**Skill folders are leaves.** A folder that holds `SKILL.md` is one skill and Tack never looks
inside it for more skills; a `SKILL.md` below it is content, delivered with the skill. Tack still
checks that nothing inside leaves the declared folder.

**Patterns.** `include` and `exclude` use the glob dialect of the docs reader's `reader.content`
and match a resource's path relative to the declared folder: a skill's folder path, a command's or
context item's file path. A resource is contributed when it matches an `include` pattern (every
path when `include` is absent) and no `exclude` pattern. A folder whose relative path followed by
`/` matches an `exclude` pattern is not entered, so nothing inside it is read or reported. Patterns
need a declared folder: on a single skill, command or file the entry is quarantined. Folders whose
name starts with an underscore mean nothing unless a pattern says so; `exclude: ["**/_*/**"]`
skips them at any depth.

**Resource folders without a declaration.** A `tack.yaml` with none of `skills`, `commands`, `context`
or `scripts` (`docs` does not count) whose root holds a folder named `skills`, `commands`, `context`
or `scripts` makes the source unhealthy with `declaration-resources-undeclared`. Its message names
each folder and the entry that declares it. Tack writes nothing: edit `tack.yaml`, or write
`skills: []` when a folder is ordinary content. A `sync` preview shows `source-unhealthy` with that
code beside each removal the unhealthy source would cause; nothing is removed until `--apply`.

A healthy source that declares no resources, no docs, and has no folder named for a resource kind is reported
as a warning, `source-declares-no-resources`, in `source`, `status` and `doctor`. It names
`manage-tack-sources` and the keys to add, and changes no exit code. A source whose every
declaration has a problem and finds no resource loads nothing: `source` marks it broken, with the
warning `source-loads-nothing`, a partial outcome and a `tack check` hint.

**Seeing declarations.** `tack source` lists each healthy source's declarations, grouped by kind
and in file order within a kind: the kind, the declared path, its `include` and `exclude` patterns,
how many resources the catalog holds because of it, and its problems with their reason codes. A
declaration that finds nothing shows `0 resources` and is not an issue, such as an empty folder
before an import. The `--json` result carries the same facts as `declarations` on each healthy
source (`kind`, `path`, `name`, `include`, `exclude`, `resources`, `problems`); like the rest of the
`source` payload it has no stable schema. `tack catalog --details` and the explorer show which
declaration found each resource. All of this is read-only.

Cataloguing never imports source modules or checks whether their dependencies or executable
contract are ready. Commands are recursive `.md` files with portable basename identities and
optional frontmatter.

```sh
tack source add /path/to/my-source
tack source add /path/to/folder --skills skills --docs handbook   # preview its tack.yaml
tack source add /path/to/skills --skills .   # skill folders at its top: preview a collection
tack source
tack source relocate <registration-id> /path/to/moved-source
tack catalog
tack status --user
```

Retire a source you no longer use with `source remove`. It names the source by label or registration
ID; a source whose directory is gone has no label, so use its ID from `tack source`. The preview lists
every agent link and docs mount Tack made for the source's resources, in every project and at user
level, the picks and docs attachments that name the source, the fixed profile applications it
affects, and the registered sources that still refer to it. `--apply` removes those links and docs
mounts, then the registration, the picks and the docs attachments. A fixed profile application the
source publishes is dropped, so its namespace returns to daily selection on its next sync. An
application that only holds members of the source keeps them as unresolved members. A source that
declares the removed one in `depends-on` is reported, because its resources that require the removed
source's resources become blocked. A link that cannot be removed safely stays as a pending removal for
`tack state clean --pending`. The built-in source and bundle-provided sources cannot be removed, and the
source directory is never touched.

```sh
tack source remove brain             # preview
tack source remove brain --apply
```

`tack check /absolute/path` checks the source before registration. Include companion source
folders to resolve external profile members. Declaration validation errors stop that source's
inspection, while other explicit inputs continue. Resources, published profiles and source-owned
docs use one combined file:line report, without state or execution.

`source add` registers an existing declaration immediately, reporting counts, issues and a
`tack check` hint. For a folder without `tack.yaml`, name what it holds with `--skills`,
`--commands`, `--context` and `--docs`, each a repeatable path inside the source. It previews the
`tack.yaml` it would write, one folder entry per flag with docs named after their folder, the name
the source would take, and what each entry finds: resource names, counts and problems.
`--skills .`, `--commands .` or `--docs .` alone writes a [collection](#collections) instead; `.`
with another flag fails with `declaration-flags-conflict` and names the commands that register the
collection and each other folder as its own source, except a context folder, which needs a folder
of a source. `--context .` is refused, two `--skills`, `--commands` or `--context` folders that are
equal or nested fail with `declaration-flags-conflict` before anything is written, and `--skills .`
on a folder that holds `SKILL.md` fails with `source-is-one-skill`. `--apply` creates the file without overwriting and registers the source
after state initialization; both name the source as a `SOURCE:NAME` reference types it. A kind flag
on a source that has `tack.yaml` fails with `declaration-exists`; a bare `source add` on a folder
without one fails with `declaration-flags-required`, and its next commands read the folder's top:
`--skills .` when skill folders sit there, with a `commands` or `docs` folder beside them as its own
source, or else one flag per folder named after a kind, such as `--skills skills --context context`.
A `tack.yaml` where a registered source's declaration reaches would take
the folder out of that source, so `source add` refuses it with `declaration-inside-source` until that
source excludes the folder. When every entry has a problem and finds no resource, the source would
load nothing: the preview is partial with `declaration-loads-nothing` and offers no `--apply`, and
`--apply` fails with that code. Scripts, patterns and `depends-on` are written by hand. Run
`tack check` until clean, then verify `catalog --details`.

Registration retains only a stable ID and canonical path. Canonical aliases reuse that ID;
relocation preserves it. A bad root declaration makes a retained source unhealthy. A bad
declaration entry quarantines only itself. Local resource errors and duplicate exact addresses
are reported alongside healthy results and recover after repair without re-registration. Links
cannot cross kind boundaries.

`source` and `catalog` show each source's label and maintainers. The same kind and name in two
sources are two healthy resources, a name clash. Every human view prints the shortest unambiguous
reference: the bare name, or `source:name` when another resource of that kind has it. A bare
reference to a clashing name fails and lists the exact commands that name each candidate. If two
sources both provide a default-activated skill with one name, neither is delivered until you run
`tack pick include <source>:<name>` for the one you want, which wins over its default-activated twin,
or `tack pick exclude <source>:<name>` for the one you do not. Including both candidates still
collides. `status` and `sync` report a collision as the same `selection-collision` diagnostic, and
the `sync` preview and the human `status` Next list name the exclude command for each candidate, with
the namespace flag of the colliding target. A failed reference keeps `--project` or `--user` in every command it suggests.

The catalog reports skills, commands, context, scripts, and declared docs. Choices support skills,
commands, and context. Skills and commands share activation metadata and dependency resolution;
context is opt-in. Delivery depends on the adapter: every adapter links skills, and Cline, Cursor,
OpenCode and Pi also link commands. Status reports selected resources with no delivery capability as undelivered. Context
has no delivery adapter yet. Scripts are catalogued and run by exact address, rather than selected; see
[script execution](#run-tack-scripts) and the [script author guide](../../packages/core/README.md).
Docs use the separate [attachment workflow](#attach-source-owned-documents).

`catalog` returns `resources`, `issues` and `complete`. Each resource carries its `kind`, equal to
its address's `kind`, and a skill or command carries its description once; `--details` adds the
complete authored frontmatter and each resource's `declaredPath`, the declared path of the
`tack.yaml` entry that put it in the catalog (a script always carries it, and the explorer shows it
as `declared by`). Each issue names its `subject`: a rejected candidate, with its
address only when one is known, or an unavailable source. `complete` is false whenever an issue
kept something out, so an empty incomplete catalog never proves absence. `catalog --kind KIND` returns the
same report scoped to one resource kind (`skill`, `command`, `context`, `script` or `docs`), keeping only
issues that can concern that kind. `catalog` only reports; `tack explore` edits.

**Exploring and editing.** `tack explore` opens the explorer in an interactive terminal and refuses
with `terminal-required` elsewhere, including under an agent marker; agents use `catalog`, `pick`
and `status`. Without a flag it opens the selection of the project that contains the current
directory, or else the destination chooser. `--project NAME` and `--user` open that selection.
Inside the window, `d` opens the destination chooser. It lists `Browse only`, then three groups:
"Daily selections" (the user and each project), "Profiles" (each published profile and a new
profile per source) and "Save selection as profile". `Browse only` and Esc on the opening chooser
leave the window read-only. In a selection, the explorer stages, previews and applies choices and
docs attachments. Each row then shows whether that destination gets the resource and why: `● default`, `● included`,
`● dependency`, `○ excluded`, `○ opt-in`, `○ other project` (its `projects` metadata names others),
`○ superseded`, `✗ blocked` (a required dependency is missing), `locked` for built-in skills, and
`● attached` or `○ detached` for docs. A project row ends with `· via user` when the user scope
delivers the resource: every project's agent also loads the user's resources, and sync does not
link one the project selects too. This is what `sync`
would deliver, not the links on disk. A staged change follows the state, such as
`● default → include`; an include of an active resource saves an explicit pick and changes no link.
A project that a fixed profile owns opens read-only: its header says `fixed by SOURCE/PROFILE`, its
rows show `● member`, `● required` or `○ not a member`, and the staging keys say to edit the
profile instead. A profile destination's rows use the same three words.

The detail pane shows `activation` for both scopes, such as `project default · user opt-in`, then
the resource's state in three groups: `user`, `projects` and, when a source publishes a profile,
`profiles`. `›` marks the edited destination. After each state it says where the state comes from:
`pick`, `fixed by SOURCE/PROFILE`, `loads in every project` (user), `loaded through user` (a project
the user scope covers) or `applied to PROJECT` (a profile). It names resources by source label,
such as `skill kit:review`. Without a destination, rows show no per-destination state.
On a resource row, `i` includes a choice, `x` excludes it, and `a` attaches or detaches docs. Each
key toggles: pressing the key that staged a change again unstages it, and the detail pane and footer name
what each key does next. `u` unstages the row, and `r` stages the removal of its saved pick (as
`pick remove` does) so the source default applies again; on a folder they act on every descendant. On a source or folder row, the same keys stage every descendant that lacks
the value; once every descendant has it, the same key unstages them. On a group already saved that
way, `i` or `x` resets its choices to declarations and `a` detaches its docs. Folder actions cover
folded and filtered-out descendants, skip built-in skills and incompatible resources, and show
all/some/none counts using the staged state. `c` reviews each child's change before confirmation
writes anything. Leaving with `q` and confirming discards the staged changes. Built-in skills stay
locked in every namespace. In a profile or save-selection destination, `i` includes members and
`x` excludes them with the same toggles; built-ins are never members.
The bare read parents `source`, `project`, `pick`, `adapter` and `docs` also accept `list` and `ls`.

State is written as format 1, under the envelope key `format` as the file's first field. This
release reads and writes format 1 only and reports `stateFormat: 1`. A format above 1 fails with
`state-format-unsupported`; anything else fails with `state-corrupt`. Every project choice names its source: there are no picks
without a source. Source relocation changes the live registration while existing links keep their
historical source evidence until reconciliation replaces them. A docs mount whose parent is no longer
an ordinary directory blocks only its own destination, and `sync` reports it as skipped until the
parent is repaired.

If a CLI rejects valid state because it cannot read its format or does not support a recorded
adapter, use a compatible release. Do not reset valid state or remove ownership evidence to make
an older checkout accept it.

For a complete layout with several declared skill paths, include/exclude patterns, two docs
resources and a named script, see the built-in source-authoring skill's
[worked source](src/builtins/skills/manage-tack-sources/references/worked-source.md). It pairs
`depends-on` with actual `SKILL.md` dependencies and walks through same-source duplicates,
cross-source name clashes and dependency disambiguation.

### Skill metadata

`SKILL.md` and command Markdown files can add Tack-specific metadata in the frontmatter's
`metadata.tack` YAML string. For example, a skill:

```markdown
---
name: review
description: Review a change for correctness and maintainability.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: opt-in
    projects: [tack]
    dependencies:
      - kind: skill
        name: git
      - kind: skill
        name: security
        source: base-skills
        optional: true
---
```

The activation settings are independent:

| Namespace                | Metadata setting  | Default when omitted | Project compatibility                   |
| ------------------------ | ----------------- | -------------------- | --------------------------------------- |
| Project                  | `activation`      | `default`            | `projects` filters default selection.   |
| User, installed globally | `user-activation` | `opt-in`             | `projects` does not restrict selection. |

Both settings accept `default` and `opt-in`. An explicit include or exclude takes precedence in its
own namespace. Required dependencies can select an opt-in skill; excluding that dependency blocks
the affected requester. Removing a choice restores that namespace's metadata policy. The bundled
`use-tack` declares `activation: opt-in` and `user-activation: default`.

Optional dependencies are included only when requested by reconciliation. Dependencies may name
skills or commands. An edge names a `kind` and a `name`, and an optional `source` label. It resolves
by these rules:

1. A resource may depend on a resource in its own source.
2. It may depend on another source's resource only if its own source lists that source's label in
   `depends-on`.
3. An edge without `source` looks in the requester's source first, then in the declared sources. One
   match is used. Several matches block the requester as ambiguous; add `source:` to the edge.
4. An edge with `source` must name the requester's own source or a declared source; otherwise the
   requester is blocked as undeclared.
5. A declared source that is not registered or not healthy blocks a required edge and skips an
   optional one, and `doctor` names `tack source add`.
6. Each dependency's own edges resolve by its own source's rules.

Required edges still extend selection, optional edges apply only on request, and cycles form one
group. Excluding a required dependency blocks its requester. Command dependencies participate in the
same closure; their delivery follows adapter support.

A blocked requester is reported as `dependency-blocked`. The human view names each blocker and the
step that lifts it, such as adding a source to `depends-on`, registering a source, or including an
excluded dependency; the JSON diagnostic carries the same blockers by reason. A dependency whose
source label names no readable source while a registered source is unhealthy is
`required-source-unhealthy`, not `required-source-unregistered`: the unhealthy source's label is
unknown, so the blocker lists its path in `unhealthySources` and the human view names `tack check`
for it.

## Import skills from GitHub

`tack import add` copies chosen skills from a GitHub location into a source you own. The copy is an
ordinary skill of that source from the moment it is written: you edit it, and `sync` delivers it
like any skill there. Tack records where it came from in the source's own `tack.yaml`, so it can
tell later whether the copy was edited. Preview by default; `--apply` writes into the source and
never into state; nothing is delivered until `tack sync`.

```sh
tack import add github:org/repo                            # what the location offers
tack import add github:org/repo --skill pdf --into my-skills   # preview the copy and its reach
tack import add github:org/repo --skill pdf --into my-skills --apply
tack import add github:org/repo --all --into my-skills:vendor/skills --apply
tack import                                                # imported skills and their local state
tack import remove my-skills:pdf --apply
tack sync --all
```

**Locations.** A location names its provider: `github:org/repo`, `github:org/repo/folder` and
`github:org/repo#REF` (a branch, a tag or a full 40-character commit). A URL names its host, so it
stays accepted: `https://github.com/org/repo`, `.../tree/REF/folder`, `.../blob/REF/.../SKILL.md`
and `git@github.com:org/repo.git`. The preview prints the canonical `github:` form beside what you
typed (`from https URL`), and every `Next` command uses it. `github` is the only provider today;
the prefix is how a second one can be added without changing what an existing location means. Bare
`org/repo` is refused with `location-provider-missing`, the exact `github:` text to retype and the
full corrected command under `Next`; `--json` carries the text as `details.suggestion`. An unknown
prefix is `location-provider-unknown`, and a URL on a host no provider serves is
`location-other-provider`. The refusal codes are the `reason` of the `import-location-invalid`
diagnostic. `@` (also after a prefix: `github:org/repo@v1`; write `#v1`), abbreviated commit IDs,
local paths, other hosts and URLs that carry credentials are refused. Private repositories use your git credentials (`gh auth setup-git`, an SSH key); Tack reads no
token. Tack runs hardened `git` only to fetch the remote, never in the destination, and the
destination need not be a git repository. Candidates are the skill folders under `skills/`, the
project skill folders of the adapters above or the named folder, to three levels, or to five with `--full-depth`;
folders whose name starts with `_` are skipped. Symbolic links and other non-regular files are
never copied.

**Choosing skills.** One candidate needs no flag; otherwise `--skill NAME` (repeatable) or `--all`.
A candidate is importable when the destination's catalog would load it: valid name and metadata, a
name the destination does not already have in any declared skills folder, a path its declaration
selects. The preview lists each verdict with its reason.

**Destination.** `--apply` requires `--into SOURCE` (a label or a registration ID, not the built-in
source). `SOURCE` uses the source's only declared skills folder; several, or none, are refused with
the `--into SOURCE:FOLDER` choices or the `skills` entry to add. `SOURCE:FOLDER` names a declared
folder, or a group folder inside one that import creates. Import never adds or edits a declaration.

**What it writes.** `FOLDER/NAME/` byte for byte, executable bits included, and one record per skill
in a top-level `imports` section of the destination's `tack.yaml`. Tack edits only that block, as
text: every other byte of the file, comments and line endings included, is unchanged, and an
`imports` key in a form it cannot own (flow style, an anchor, indented, repeated) is refused with
the line number. A record holds the folder, location, ref, resolved revision, upstream folder and
tree, import time, and the SHA-256 and executable bit of each file; the location is written
`<provider>:<text>` (`github:org/repo`), so the provider is the prefix and there is no separate key; with it `tack import` tells
whether the copy was edited, offline. The write goes through `.tack-import-staging/` at the source
root under the state writer lock, so an interrupted run leaves either the old or the new folder and
a whole `tack.yaml`; the next `import add` or `import remove` with `--apply` for that source
finishes or rolls it back. A source with an `imports` section is unhealthy for releases that predate
import.

**Reach.** The preview says where the skill will be delivered at the next `sync`, using the
destination's normal activation: the projects that receive it and those that do not and why, the
user namespace, a same-name skill from another source (both load, and `sync` plans a `collision`
exactly as for two registered sources), old picks that would select nothing, and dependencies on
sources the destination does not declare. A skill without Tack metadata reaches every registered
project. A project a fixed profile holds is listed apart as not delivered (`fixedProfileProjects` in
JSON), with the profile and the `tack profile apply ... --force` command that delivers the skill
once the profile names it.

**Remove.** `tack import remove [SOURCE:]NAME` deletes the folder and its record. A locally changed
folder needs `--force`, and the preview then lists every change that is lost; Tack keeps no copy.
The next `sync` removes the links. `import`, `import remove`, `source`, `catalog`, `status` and
`doctor` work offline; only `import add` uses the network. Import payloads are not part of the
stable JSON contract.

## Register projects and choose skills

Projects are Git repositories. Registering a project records its Git anchor and all reachable non-bare worktree roots. This gives project commands a stable name even when you run them from another directory.

```sh
cd /path/to/repository
tack project add tack
tack project
```

`project add` registers at once; there is no preview. It writes no link, and `project remove` undoes it. It also lists the hand-made entries in the project's agent folders: the files, folders and links in the skill and command folders of the enabled agents, in every worktree, that Tack has no record of. They are information only: Tack leaves them where they are, and one named like a skill Tack links shows up as `hand-made` in `status` after `sync`. `project refresh` lists them for the worktrees it adds or brings back. In JSON both are under `handMade`, in `applied` for `project add` and in `plan` for `project refresh`.

Pass `--repository-cwd <path>` to register a repository from another working directory. Refresh registration after worktrees change:

```sh
tack project refresh                 # preview this project's worktrees
tack project refresh --apply
tack project refresh --all           # preview every registered project
tack project refresh --project tack --apply
```

Retire a whole project with `project remove`. The preview lists every agent link and docs mount in
the project's roots, its picks, its docs attachments and its fixed profile application. `--apply`
removes the links and docs mounts, then the project with all of its intent. When a link cannot be
removed safely, the project stays as `removal requested` until a second `project remove --apply` or
`tack state clean --pending --project NAME --apply` settles it. The worktrees are never touched. A
single worktree that went away leaves through `project refresh --apply`.

```sh
tack project remove tack             # preview
tack project remove tack --apply
```

Selections are independent for each project and for the user target. A choice names one resource by
a reference: `name`, or `source:name` where the source is a label or registration ID. A bare name
works when exactly one healthy resource of the accepted kinds has it. Otherwise the command fails,
changes nothing and lists every candidate with the exact command that names it. `--kind` (`skill`,
`command` or `context`) is needed only when one name exists in several kinds.

```sh
tack pick include review --project tack
tack pick include review --kind command --project tack
tack pick include notes.md --project tack
tack pick include quality-tools:review --kind skill --project tack
tack pick exclude audit-tools:review --user
tack pick --project tack
tack pick remove review --user
```

A new choice stores the exact resource: namespace, source registration, kind, name and decision. It
never stores the label, so renaming a source breaks no choice. `pick remove` resolves its reference
against the namespace's stored choices, so it also works for a resource that has left the catalog.
`pick include`, `pick exclude`, and `pick remove` accept registered resources only and require exactly one namespace: `--project <name>` or `--user`.
`pick` without either selector lists choices across namespaces. It returns
`{ "kind": "choices", "choices": [...] }`. The user namespace installs to the current user's adapter
directories.

Every pick names its source, so a reference that matches several sources fails with the command for
each candidate instead of storing an ambiguous pick. `pick remove` takes `<source>:<name>` or a bare
name that matches one stored pick, with `--kind` when kinds clash.

For `sync`, `status`, and `state clean`, `--project <name>` selects that project's
active worktrees and pending removals; `--user` selects the user target. Without a selector, these
commands select only the project containing the current directory or `--cwd`. Bare commands fail
outside a registered active root. `project refresh` also finds a registered project by the Git
directory of a new worktree. `--all` explicitly selects every project and the user target, except
that refresh has no user target. `--cwd` cannot be combined with a selector on these six commands.
Agents should prefer `--project` or `--user` and must not add `--all` to recover from a failed bare
selection. Plans and status echo `selection: { selector, containingRoot?, targets }`, where
`containingRoot` names the project and root found for a bare request.

## Sync

`sync` previews selected resource links and attached project docs mounts together. `--no-docs`
omits mounts; `--no-adapters` plans docs mounts only for a project. The plan's `options` echoes
`--adapter`, `--require-capability`, `--include-optional` and `--no-docs` when given, and the human
Next command repeats them, with `--no-adapters` (a plan without `resources`), so applying it writes
exactly what the preview showed. `project refresh`, `project remove`, `source remove`,
`adapter disable`, `state clean`, `state clean --pending`, and `state reset` also preview
before writing. Add `--apply` to replan and write; the response carries the
plan it applied together with the outcomes in `applied`. Source registration with an existing
declaration, choices, adapter settings, and docs attachment/configuration persist immediately.

```sh
# Preview one project explicitly.
tack sync --project tack

# From a registered active worktree, reconcile its project.
tack sync
tack sync --apply

# Preview every project and the user target explicitly.
tack sync --all

# Limit the target or adapters.
tack sync --project tack --apply
tack sync --user --apply
tack sync --adapter claude --adapter codex --adapter cursor --apply

# Include optional dependencies, or plan without adapters.
tack sync --include-optional
tack sync --project tack --no-adapters
tack sync --project tack --no-docs
```

Use explicit selectors to limit scope as described [above](#register-projects-and-choose-skills).
For `sync`, `--require-capability command-links` blocks every unit whose adapter lacks that
capability; such a unit plans no work and reports `capability: { _tag: "blocked" }`. Each plan unit
also states which kinds its adapter delivers, such as
`delivery: { skill: "delivered", command: "unsupported" }`; a selected resource of an unsupported
kind is not linked for that adapter.

Each managed link is relative text computed from the real directory that contains it, which is
where the operating system resolves it. An agent directory or home reached through a symbolic link,
such as dotfiles managed by stow or chezmoi, still links to the source. `status` and planning
observe links the same way, so a link that only resolves lexically is reported as drift.

An operator's in-root alias between agent directories, such as `.claude/skills -> ../.agents/skills`,
is recognized when it is a relative link to a real directory inside the same target. Adapters
reaching one physical directory share one link: one adapter writes it and holds its evidence, the
others report it as `matching` with a `sharing` entry, and a plan unit lists the alias under
`directoryAliases`. A dangling alias, an alias to a file, an absolute alias, and an alias that leaves
the target remain `destination-directory-conflict`. Two resources with one name in the shared
directory remain a collision. Cleanup and `adapter disable` remove a link only with evidence, and a
removal preview names the other adapters that reach the directory in `alsoReachedBy`; the next
`sync` restores any link that is still selected.

A managed link whose recorded source was deleted or moved no longer resolves. Tack still owns it
when its link text is exactly the text Tack writes for its evidence. Reconciliation then replaces
it if the resource is still selected, or plans a `link-remove` action with reason
`source-missing`; `state clean` and `state clean --pending` remove it. A dangling link with any other text is not
Tack's, so it is never removed.

A `link-remove` action names why the link goes in `reason`, which the text view prints beside the
resource. `deselected` means the operator's choices no longer select the resource. Two reasons mean
the resource is held back while still chosen. `source-unhealthy` means its registered source cannot
be read, such as a `tack.yaml` with an unknown key or resource folders it does not declare. `quarantined`
means the catalog quarantined the resource itself, such as a `SKILL.md` that no longer validates.
Fix the source or the file and the next `sync` links the resource again. The other reasons are
`blocked` (a required dependency is blocked; the action names its `blockers`), `collision`,
`linked-for-user`, `source-missing`, and `replace` (the link is rewritten for the same name,
followed by its `link-create`).

A project does not link a skill or command that the same adapter links for the user: agents in the
project load it from the user's folder, so they list it once. The plan unit names such resources in
`linkedForUser`, and the text view shows each as `skip … linked for the user`. A project link made
before the user pick is removed with the reason `linked-for-user`, and `status` lists the resource
as undelivered with that reason. The plan decides from the selection, so after the user pick is
removed the next project sync links the resource into the project again. A project resource of
another source with the same name is not affected.

A recorded link that was changed outside Tack, such as one pointed at a copy of the skill inside the
repository, is left in place. While its resource is selected, `sync` reports it as
`managed-link-drift`. Once the resource is deselected or gone from its source, `sync` releases it:
the plan carries an `evidence-retire` action with reason `released` (counted in the unit summary's
`release`), the text view notes it once as `release <path> … changed outside Tack, no longer
managed`, and applying it forgets the record without touching the link. A dangling link with
foreign text is released the same way. Until then `status` reports the destination as
`evidence-changed`. A changed link whose name two selected resources collide on stays
`managed-link-drift` until the collision is resolved. A recorded link that is absent is retired with
reason `absent`.

A link Tack has no record of that is exactly the link Tack would write, with byte-identical text
that resolves to the selected source, is adopted. A link committed to a repository arrives this way
in every other clone: Tack wrote it in the clone that committed it. The plan carries a `link-adopt`
action (counted in the unit summary's `adopt`), the text view shows it as `adopt <path> … already
linked, record only`, and applying it records the link as Tack's own without touching it. `status`
reports it as `unrecorded` until then, and afterwards removal, refresh, `status` and `doctor` treat it
like any link Tack created. Any other entry in the way, such as a link with other text, a file or a
folder, stays a `foreign-destination` conflict: Tack never replaces it. The conflict names what is
there and, in `expectedTarget`, the link text Tack would write. `git rm` the entry when the
repository commits it, or move it away, and ignore Tack's links in `.gitignore`; then sync.

Configure the enabled adapters independently. `adapter enable` cannot remove existing adapters; removing
one requires `adapter disable` and its cleanup workflow:

```sh
tack adapter enable claude codex cursor
tack adapter
tack adapter disable cursor       # preview cleanup and disablement
tack adapter disable cursor --apply
```

`adapter` returns `{ "kind": "adapters", "enabledAdapters": [...] }`: the enabled adapters, not
every known one.

## Run Tack scripts

Tack runs trusted local scripts declared by a registered source. Each declared `.ts` entrypoint
default-exports a `defineScript` definition imported from `@tackup/cli`, which the running Tack
provides: a source never installs it. The built-in
[scripts reference](src/builtins/skills/manage-tack-sources/references/scripts.md) is the author
guide. A source needs a root `package.json` only for packages its scripts import; Tack checks they
are installed and never installs them. Cataloguing requires only declaration metadata; listing does not
import modules or check executable readiness.

```sh
tack catalog --kind script
tack script show report
tack script run report --project demo -- --name Ada --times 2
tack script run report --project demo --input-json '{"name":"Ada"}'
tack script run nested-report --root /path/to/registered/worktree --input-file input.json
tack script run quality-tools:report --user --input-stdin --timeout 30000 --quiet < input.json
```

A script is named by one reference: the `name` its source declares in the `scripts` list of its
root `tack.yaml`, qualified as `source:name` when another source declares the same one.
Quarantined, duplicate, and undeclared scripts cannot run. Run history records store the source registration and the
name.

A run has exactly one target. `--user` uses the operator's home directory. `--project NAME` requires
that project to have exactly one active registered root; use `--root PATH` to choose an exact
registered root in a project with several roots. These target flags are mutually exclusive.
Without them, the current directory must be inside an active registered root and only the deepest
such root is selected, even when it is also the home directory. `--cwd PATH` changes this directory lookup. This run behavior differs from the project
maintenance scope of bare `sync` and `status`. The selected root or user home is the default
working directory of both the worker and Shell capability.

Target resolution failures name the input to change, and the outcome `details` carry it. Run
outcome codes use snake_case, unlike the kebab-case codes of other CLI diagnostics.

| Code                         | Cause                                                                | Details                                         |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `state_not_initialized`      | The state directory has no state; run `tack state init` first.       | `stateDirectory`                                |
| `run_project_not_registered` | `--project NAME` names no registered project.                        | `projectName`                                   |
| `run_cwd_not_registered`     | The current directory or `--cwd` is outside every active root.       | `cwd`                                           |
| `run_cwd_unavailable`        | The current directory or `--cwd` is not an accessible directory.     | `cwd`                                           |
| `run_root_not_registered`    | `--root PATH` is not exactly a registered active root.               | `root`, and `containingRoot` when nested in one |
| `run_root_unavailable`       | `--root PATH` is not an accessible directory.                        | `root`                                          |
| `run_target_not_unique`      | The project has several active roots; choose one with `--root PATH`. | `projectName`, `roots` (canonical active roots) |
| `run_target_unavailable`     | The project has no active registered root.                           | `projectName`                                   |

`tack types [PATH] --apply` writes `tack-env.d.ts` into a source folder (default: the current one):
the script API's types as an ambient `@tackup/cli` module, from the running Tack. It also writes
a `tsconfig.json` when the folder has none, and otherwise warns with `types-stub-out-of-scope` when
the existing one does not include the stub. Without `--apply` it previews. A folder without
`tack.yaml` is refused with `types-not-a-source`.

`tack script show REFERENCE` loads the script in a fresh worker, without running it, and prints
its description, file, arguments (with types, defaults, choices and descriptions) and secrets. A
module that is no script fails with the same code a run would report.

Pass the script's arguments after `--`: `--name value`, `--name=value`, a boolean as `--flag` or
`--no-flag`, a list argument repeated. A camel-case name also answers to its kebab spelling.
Words before `--` that Tack does not know are refused. Alternatively choose one JSON input
source: `--input-json JSON`, `--input-file FILE`, or `--input-stdin`, never together with words.
With none, Tack supplies `{}`. Every argument problem is reported at once as `invalid_args`, one
per line. History keeps the words as `originalWords`, or the JSON as `originalInput`. `--timeout` is a positive integer in milliseconds. The first
operator signal or timeout aborts the script's `signal` and waits for its cleanup; a second signal
or grace expiry can force the worker to stop. The result retains the initiating reason and whether
cleanup completed.

Each run gets a fresh worker and only its declared secrets. Put declared
secret values under `TACK_<NAME>` in the state directory's operator-owned `.env` or the invoking
process environment. A process value takes precedence, including an empty value that causes a
missing-secret failure. Declared secret values travel as private capability data rather than
ambient worker environment variables, and Tack replaces each value with `<redacted>` in logs,
results and messages. A value a script writes to a file or passes to a command is its author's
responsibility. `exec` takes an executable and argument list without implicit shell parsing, and
throws on a non-zero exit unless the script passes `allowFailure`.

Standard output contains one JSON envelope. Bounded captured standard streams, script logs, and
`exec` output are mirrored to standard error in observed order. `--quiet` suppresses this mirroring
while preserving logs and explicit truncation evidence in the result and history. Outcomes
identify their stage and code, including argument, expected, secret, cleanup, timeout, worker,
and history failures. A script's thrown error shows its message, with secrets scrubbed; other
defects are sanitized. Cleanup failure preserves the primary result and makes the run unsuccessful.

## Inspect run history

```sh
tack script history
tack script history show RUN_ID
tack script history clear
tack script history clear --apply
```

Tack reads the state document before writing history, so a run against an uninitialized state
directory returns `state_not_initialized` and creates no files. Otherwise, every recognized run
attempt creates a durable pending history record before target and script resolution, input
reading, or module import. An initial history-write failure prevents execution. A terminal-write
failure leaves the pending record visibly incomplete and reports a persistence failure alongside
the available run outcome. History stores bounded original JSON, schema-encoded values when
available, logs, classification, and finalization evidence. It does not serialize arbitrary runtime
objects. `script history` returns `kind: "run-history"` with its `runs`, `total`, `offset`, `limit`,
`truncated` and `issues`. Records remain until explicit clearing or completed state reset. `script history clear` previews
the number of records; `--apply` deletes them.

## Inspect and maintain state

`status` reports source, project, resource selection and delivery, destination, and pending-removal
health for the selected scope.

```sh
tack status
tack status --project tack
tack status --user
```

Status classifies each destination by the decision `sync` would make for the same scope, so
after a successful `sync --apply` every destination reports `matching`. Pass
`--include-optional` to inspect the state that `sync --include-optional` delivers; without it,
optional links report `drift` because a plain `sync` would remove them. Status plans the same
targets and links `sync` acts on: a missing or unhealthy project root is reported on its project
(`root-missing`, `root-unhealthy`) and lists no destinations, and the built-in skill links under a
user target with a fixed profile, which `sync` leaves as they are, are not listed.

### Check machine health

`tack doctor` is the one read-only health report. It is machine-wide, works before `init`, never
prompts, fetches or repairs, and changes no file. It reports one check for each area: `release`
(the running version), `state`, `adapters`, `sources`, `projects`, `links` (built-in skill links
included), `docs` and `unregistered-dependency-source`. The `sources` check groups quarantined
candidates per source, telling declaration problems from other ones, and names `tack catalog` as the
next command. The `projects` check reads where doctor runs: with no project registered, a Git
repository there is a warning that names `tack project add NAME`; a worktree of a registered project
that refresh has not added is a warning that names `tack project refresh --project NAME`, because
that worktree has no links. The `links` check fails on drift, foreign entries and pending removals,
but only warns on a hand-made entry: a file or folder that was at a destination before Tack linked
there, which `status` tags `hand-made` (diagnostic `destination-hand-made`). Tack keeps it and links
everything else; the warning names `tack pick exclude SOURCE:NAME --kind KIND --project NAME` to keep
yours on purpose, which unlinks Tack's resource for every agent of that project. Each check has an
outcome of `ok`, `warning`, `failed` or `skipped`, a message and, when a cause is known, a `next`
argv array: the exact command that addresses it, as a preview unless the operation is immediate.
It never guesses `--all`, and carries `--state-dir` when you chose the state directory.

```sh
tack doctor
tack --json doctor
```

Warnings and skipped checks exit `0`. Any failed check is a `domain` failure that exits `1` and
still carries the whole report in `result` (`checks` and a `summary` of counts), plus one
`doctor-check-failed` error diagnostic for each failed check. A missing state is a warning with
`tack init` as its next step, and the checks that need state are skipped. A state with no enabled
adapter is an `adapters` warning that also names `tack init`. A state written by a newer
Tack fails the `state` check. An unreadable or corrupt state document is a persistence failure that
exits `3`, because the report could not be trusted. `status` stays the selected delivery report;
its problems and repair hints agree with `doctor`.

Use `state clean` to remove currently managed links from a selected target. Use `state clean --pending` to retry pending removals, agent links and docs mounts alike. Both commands need `--apply` to change files.

```sh
tack state clean --project tack
tack state clean --project tack --apply
tack state clean --pending --user --apply
```

`state reset` plans removal of every managed link and state record. `tack state reset --apply` applies that cleanup and deletes Tack state only after cleanup settles.

## Automation contract

Tack prints a compact text view by default, in terminals, pipes, CI and agent shells. Agents read it
and follow its `Next` block; they do not pass `--json` for ordinary work. Text views serve operators
and change in any build: do not parse them. Pass `--json` only when a program parses the result. A
foreground `docs serve` command reports startup readiness or failure in its envelope.

The payload inside the envelope is a stable, schema-backed contract only for the commands programs
parse: `status`, `sync` and `init` (preview and apply), `doctor`, `upgrade` (with
`upgrade status`) and `version`. Every other command still prints JSON with `--json`, but its payload has no schema and no
stability promise: do not build automation on it.

`--json` requests the version 1 envelope, including for help and invalid invocations. `--format`
fails with a replacement hint, and `TACK_FORMAT` has no effect. Terminal and agent facts still
control color and interactive features.

The versioned envelope has fixed keys:

```json
{
  "version": 1,
  "command": "sync",
  "status": "success",
  "classification": "success",
  "diagnostics": [],
  "next": [],
  "plan": null,
  "applied": null,
  "result": null
}
```

A non-null payload is an object whose `kind` names its response family (stable only for the commands
named above), such as `initialization`,
`source-registration`, `project-registration`, `choice-change`, `choice-removal`, `choices`,
`adapter-settings`, `adapters`, `docs-settings`, `docs-list`, `docs-target`, `run-history`,
`script-run`, `reader-session`, `reader-search` or `version`; `script history show` returns the retained record
without a `kind`. Dispatch on `kind` rather than on payload shape.

`next` lists the commands the text view prints under Next, as exact command strings with source
labels, never registration IDs; it is empty when nothing is suggested. Run them as written. `doctor`
keeps its per-check `next` argv arrays.

`status --json` publishes a trimmed payload: `catalog` holds only the counts `resources`,
`quarantined` and `unavailable` (run `tack catalog` for the resources), and each destination names
its resource once as `address` (`candidates` for a `selection-conflict`) and carries `observed`, what
is on disk, only when it is not `matching`. A healthy link has `_tag: "matching"`; every other `_tag`
needs attention, and `expected-absent` means a link is expected and missing. The payload schemas carry
a `description` for each of these values.

`status` is `success`, `partial`, or `failure`. `partial` means the command ran and something needs
attention, so it exits `1` without being a Tack failure. `classification` gives the cause: `success`, `partial`, `invalid-invocation`, `invalid-configuration`, `domain`, `persistence`, `internal`, or `interruption`.

Each partial or warning diagnostic has a specific kebab-case `code`, such as `no-adapters-enabled`,
`root-missing`, or `destination-foreign-entry`, and names what it concerns in `details.subject`.
Script run outcome codes are snake_case, as described [above](#run-tack-scripts).

A docs mount whose removal is still owed is reported with the agent obligations. `status` and the
`sync` plan and application carry `docsPendingRemovals`, an array present only when a removal is
owed, in destination order: each entry holds the `cause`, the docs link `evidence` (project, root,
resource, destination, source directory and link text) and, once attempted, its `lastResult`
(`blocked`, `filesystem-failure` or `interrupted`, with a `message`). `sync` reports only the
projects it covers. Each owed docs removal is also a `pending-removal` partial diagnostic in
`status` and `sync`, and the `links` check of `doctor` counts it among its pending removals and
names `tack state clean --pending` as its next step. A removal result carries the same array as
`docsPending`, and `docsActions` reports each docs mount's outcome with the `blocked` tag when the
mount stays owed.

A planned docs link that cannot proceed is a `partial` diagnostic whose `code` names its cause, in
`sync` preview and apply alike, with the link's `resource` and `destinationPath` in `details.subject`:
`docs-destination-occupied` (an existing entry sits where the link would go; it is never adopted or
overwritten), `docs-destination-modified` (the recorded link was changed, so ownership does not
authorize removing it), `docs-parent-not-directory` and `docs-parent-redirected` (a parent of the
destination is not an ordinary directory, or has been redirected), `docs-parent-unreadable` (a parent
could not be inspected), `docs-root-moved` (the registered project root has moved), and
`docs-destination-escape` (the destination is outside its registered root).

A source that cannot supply resources is reported with its own code. An unhealthy source carries
`declaration-resources-undeclared` in `issue.code` of `status` and `source`, in the `sources`
check of `doctor`, and as the cause beside each removal a `sync` preview plans for it
(`source-unhealthy`). A declaration entry that Tack cannot use is a quarantined candidate whose
code names the reason: `declaration-entry-invalid` (the entry does not decode, or has patterns on a
single resource), `declaration-path-invalid` (the path breaks the syntax rules),
`declaration-path-outside-source`, `declaration-path-missing`, `declaration-path-wrong-type`,
`declaration-path-overlap` and `declaration-reaches-source` (the path is or reaches another
source's folder), beside the existing `resource-boundary-violation`. A healthy source that
declares no resources and no docs carries the warning `source-declares-no-resources` in the
`warnings` of its entry in `source` and `status`, and as a `warning` in the `sources` check of
`doctor`. A warning changes no exit code.

`tack [PATH...] --help` (there is no `help` word) returns the grammar of a command path: usage, arguments, flags, mutation mode,
examples, and direct subcommands. `tack PATH... --help` is the same. Bare `tack --help` is the operation
map: every operation once, grouped by task, with its mode (`read`, `now`, `plan`, `run` or `conditional`), the target
rule and the output rule. `tack status --help` also says what each link state means and what to run.
Help works before `init` and reads no state.

`tack --version` reports the running version before `init`, with no state and no
home directory. `tack --json --version` returns `{ "kind": "version", "version", "commit", "stamp",
"sourceRun", "stateFormat" }`. Every package in the repository shares one plain SemVer `0.y.z` version, and a source run,
as `bun tack` is, reports `0.y.z+dev` with a `null` commit. A built release stamps its commit as `0.y.z+g<commit>`
and, when it was ahead of `origin/main`, `0.y.z+g<commit>.ahead.<n>`. Build metadata does not affect version order.
The version is separate from the envelope `version`, the state format version and the script contract
version, which keep their own numbers.

Exit codes are stable: `0` for success, `1` for partial or domain failure, `2` for invalid invocation or configuration, `3` for persistence or internal failure, and `130` when interrupted.

An `internal` failure keeps its cause out of the envelope and names one next step: the same
command with `TACK_DEBUG=1` before it. With `TACK_DEBUG=1` set, Tack writes the full cause, with
the use case that failed, to standard error before the output; the envelope is the same either way.

## Fixed profile authoring

Publish `{ name, path }` entries in `profiles` in a version-2 `tack.yaml`. Each file has its own
version-1 schema: `name`, optional `depends-on` source names and positive `members`. Bare members
resolve only in the owning source; external members use `{ name, source, kind? }`. Required
resource dependencies expand; defaults, picks and optional dependencies do not.

`tack check SOURCE_PATH [COMPANION_SOURCE...]` checks all its profiles; a profile file can also
be passed directly. This reads only files in the authoring scope and reports structure, linkage
and separate direct/required inventory. In `tack explore`, press `d` and choose a profile under
Profiles, or a new profile. Save writes only the profile and its publication; pending
edits require save/discard/cancel before changing destinations.

Use the built-in `author-tack-profiles` skill for an example and compatibility guidance.

Profile deployment uses `tack profile apply SOURCE:PROFILE --project PROJECT --target-root ROOT`
(repeat the root flag for the complete project). Preview is read-only; `--apply` retains exact
intent before ownership-safe delivery. Existing intent or owned deliveries require `--force`,
including empty/incomplete prior applications. Force never permits partial roots, unsafe parent
links or foreign content replacement. For user targets, bind matching HOME with `--target-home`
and an explicit state directory inside that isolated home. Sync retains the applied inventory,
refuses changed dependency closure and exposes fixed intent in status/doctor. Ordinary selection
edits in fixed contexts refuse. The state stores this intent.

Built-in skills are always delivered and locked. Selection copies omit them and say so in preview. A hand-written profile may still name them: check warns with `profile-builtin-omitted`, while adopt/apply skip those members with a note. They do not become picks or fixed inventory. Ordinary resources with the same name in another source remain normal members.

Copy daily membership with `tack profile save SOURCE_PATH NAME --project PROJECT`: the default
input is user + one named/containing project, with `--input user` or `--input project` alternatives.
The preview shows origins, membership changes and file/publication changes; `--apply` saves only
the profile. Existing profiles require `--edit`. In `tack explore`, choose a save input in the
same destination window, review/adjust members, choose source/name, then review the authoring diff.

`tack profile adopt SOURCE:PROFILE --project PROJECT` (or `--user`) previews a one-time copy to
ordinary positive picks and project docs attachments. `--apply` writes intent without syncing,
leaves unrelated picks and writing defaults intact, and reports remaining ordinary blockers.
User-only docs and fixed contexts refuse. Scripts remain explicit-run resources. Saving and
adopting create no subscription: later changes on either side leave the other side unchanged.

`profile export SOURCE:PROFILE OUTPUT.tar.gz` previews a content snapshot of direct/required
resources, exact files, integrity facts, imported current-byte provenance and non-secret setup.
`--apply` creates a new artifact without overwriting an occupied path. Script/docs support needs
version-2 `bundle-support` entries with kind/name, `complete: true`, `files` and `prerequisites`.
Self-contained scripts can declare `package: none`; external packages need included package/lock
facts and explicit setup requirements. Unknown helpers, reader modules/assets or computed imports
refuse a complete export. The built-in profile skill contains worked support examples.

`profile inspect-bundle FILE` reads its inventory. `tack check FILE` validates archive safety,
manifest integrity and actual projected profile linkage offline without state or original sources.
Profile docs use the same effective inventory for mounts, list/search/serve and writing-target
lookup. Unsupported adapter delivery remains partial on retry/sync/status and fails doctor until
all enabled adapters support the fixed inventory. Context and scripts keep their informational roles.

`profile apply-bundle FILE --project NAME --target-root ROOT` previews the same complete-target
contract as source apply. `--apply` retains content under the explicit state directory, registers
fresh bundle-provided sources and applies fixed inventory. A fresh init/project/adapter context
needs no original source registrations, prior ordinary sync or force. Existing intent, including
empty/incomplete applies and exclusions, still needs force; physical boundaries and foreign files
remain protected. Originals, even newer same-name sources, remain independent. Artifact bindings
never fall back to originals, and projected defaults never enter unrelated contexts automatically.

Bundle version 1 is a bounded regular-file/directory POSIX ustar archive in gzip: 8 MiB compressed,
32 MiB expanded, 8 MiB per file and 5,000 entries. Traversal, absolute/case/Unicode-conflicting or
duplicate paths, unsafe parents, links, special files, unsupported versions and bad facts/digests
refuse before target mutation. Known operator/configuration/credential/dotenv/history paths are
excluded/refused; arbitrary authored text is not certified secret-free. Checksums establish
integrity, not publisher authenticity. No supplied script, module, reader component, hook,
installer or fetch runs during bundle operations, and content portability does not guarantee
offline script execution.

Identical reapplication reuses only matching verified artifact/source registrations and content;
force is still required when target intent exists. Changed retained mappings/bytes, duplicate keys
or foreign payload paths report repairable identity conflicts, never overwrite or rebind authority.
Retained projections are immutable and cannot be edited/relocated as authored sources. Different
revisions remain separate, and payloads remain for ownership/recovery even after incomplete
zero-link delivery. Status/doctor report retained integrity failures as `source-bundle-changed`.
Existing upstream skill import remains a separate workflow.
