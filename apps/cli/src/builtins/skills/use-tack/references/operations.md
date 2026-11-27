# Tack operations

Detail behind `use-tack`: it owns the output rule, the executable, state and scope, and which JSON is stable. Replace
uppercase arguments with values obtained from inspection. Examples use the installed `tack`; a
source run swaps in the form `use-tack` gives. Read the text view; add `--json` only when a program parses a stable payload.

## Set up Tack and its built-in skills

The operator installs Tack with `npm install --global @tackup/cli` (Node 22.12 or later), or
with `bun add --global @tackup/cli` and runs it with `bun --bun`. The package manager owns the
executable and its upgrades. On first use Tack copies its built-in skills into
`~/.tack/builtins/<version>/` (`TACK_BUILTINS_DIR` moves it; `--state-dir` never does), so agent
links never point into the package manager's folder. After a sync, Tack removes older copies that
no link of the state uses, keeping the newest older one for other states.

Tack ships `use-tack`, `manage-tack-sources`, `author-tack-profiles`, `write-reader-figures` and
`prepare-tack-checkout` through a built-in source, visible in `source` and `catalog` without registration. Built-in skills are locked in
`tack explore` for both `--user` and `--project`. `pick include`, `pick exclude` and
`pick remove` refuse them with `builtin-skill-locked`. Built-in skills are always delivered at user scope: `sync --user --apply` links
each one once per user into the user skill directory of every enabled adapter, such as
`~/.claude/skills`. Tack needs them, so they cannot be opted out. After an upgrade,
`tack init` relinks them to the new version.

Set up a machine. `init` writes at once and has no `--apply`:

```sh
tack init
tack init --adapter claude --adapter cursor # these agents instead of the detected ones
```

`init` plans, then applies, in order: the state and its `.env` when absent (it keeps an existing state, and a
state this release cannot read fails it before anything is planned); the adapters to enable, which
are the agents whose home exists (`claude` from `~/.claude`, `cline` from `~/.cline` or
`~/Documents/Cline`, `codex` from `~/.codex` or `~/.agents`, `copilot` from `~/.copilot`, `cursor`
from `~/.cursor`, `gemini` from `~/.gemini`, `opencode` from `~/.config/opencode`, `pi` from `~/.pi`)
unless `--adapter` names them, never disabling one; and the plan
`sync --user` makes once they are enabled, which on a new machine links the built-in skills. It also
lists, as information, the hand-made entries in those agents' user skill and command folders: files,
folders and links Tack has no record of. It leaves them untouched; one at a built-in's path is that
link's `foreign-destination` conflict, and everything else still applies. It creates the state when
absent, then plans and, under one writer lock, enables the adapters and applies that plan. Its view
says what it created, enabled, linked and removed, with every link action. On a set-up machine it
writes nothing and says so, so rerun it after every upgrade. It never touches sources, projects or
picks.

A first `init`, the one that creates the state, names `tack guide onboarding` first under Next. With
no agent home found and no `--adapter`, `init` sets up the state only and is partial with
`agent-home-not-found`; its Next then names `tack init --adapter claude`. Its JSON is stable:
`plan` is an `init-plan` with `state` (`create` or `exists`), `adapters` (`enabled`, `toEnable`,
`detection` and `source`), `user` (the `sync-plan` of `sync --user`) and `handMade`; `applied` is
an `init-application` with `state` (`created` or `existed`), `adaptersEnabled` and `user` (the
`sync-application`). Both are always present.

`tack guide` lists the guides of the running Tack, and `tack guide TOPIC` prints one as it ships:
`onboarding`, `agent-instructions` or `day-two`. It reads no state, needs no setup and writes
nothing, so it works before `init`. A topic it does not have fails with `guide-topic-unknown`.

## Set up sources and projects

```sh
tack check /absolute/path/to/source
tack init # if the machine is not set up
tack source add /absolute/path/to/source  # preview a source that has tack.yaml
tack source add /absolute/path/to/source --apply  # register it
tack source add /absolute/path/to/skills --config '{"version": 1, "name": "skills", "skills": [{"path": "."}]}'  # preview its tack.yaml
tack guide tack-yaml  # every key a tack.yaml takes
tack project add PROJECT --repository-cwd /absolute/path/to/repository
tack catalog --details
```

`tack state init` creates state and an operator-owned `.env` without overwriting existing files,
and nothing else; `init` uses it. Without state, the first `source add`, `project add` or other
registration initializes the default state and enables the agents found in the home, and its
`state-initialized` note names them; run `tack init` to link the built-in skills too. Projects are Git repositories; registration records the repository
and its reachable non-bare worktrees. `project add` registers at once, with no preview, and lists, as
information, the hand-made entries in the enabled agents' project skill and command folders of every
worktree; `project refresh` lists them for the worktrees it adds. Both leave them untouched. `tack adapter enable claude codex cursor` adds adapters to the
enabled list; it never removes one. Use `adapter disable` to remove an adapter and its managed links.

Move a registered source with `tack source relocate SOURCE_ID /absolute/path/to/new/location`.
This preserves its registration identity. Reconcile affected skill and docs links afterward.

Retire a source with `tack source remove SOURCE` (a label, or the registration ID of a source whose
directory is gone) and a whole project with `tack project remove PROJECT`. Both preview first. The
source preview lists its links and docs mounts everywhere, the picks and docs attachments that go,
the fixed profile applications it drops or leaves with unresolved members, and the sources whose
`depends-on` still names it. The project preview lists its links, docs mounts, picks, docs
attachments and fixed profile application. `--apply` removes them and the registration. Neither
touches the source directory or the worktrees. Built-in and bundle-provided sources cannot be
removed. Run them only when the operator asks to retire that source or project.

## Catalog and selection defaults

Selection defaults come from resource metadata, which the `manage-tack-sources` skill owns: project activation defaults to `default`, and user
activation to `opt-in` unless a skill sets `user-activation: default`. Context items carry no
metadata and are always opt-in. Removing a choice restores the metadata policy. Dependencies are declared per resource in `metadata.tack.dependencies`; a resource may depend on its own source, and on another source only when its source lists that source's label in `depends-on`. A required
dependency is selected with its requester even when it is opt-in; excluding it blocks the
requester.

`catalog` returns `resources`, `issues` and `complete`; `complete: false` means an issue kept
something out, so an incomplete catalog never proves absence. `catalog --kind KIND` scopes it to
`skill`, `command`, `context`, `script` or `docs`, and `--details` adds each resource's complete
frontmatter and its `declaredPath`, the `tack.yaml` entry that found it. `source` lists each healthy
source's `declarations` with their patterns, resource counts and problems. `source`, `status` and
`doctor` report a healthy source that declares nothing with the warning
`source-declares-no-resources`. A warning changes no exit code. `source` marks a source whose every
declaration has a problem and finds no resource as broken, with the warning `source-loads-nothing`
and a partial outcome. Reading these facts is operating Tack; changing a declaration is
`manage-tack-sources`.

The bare read parents `source`, `project`, `pick`, `adapter`, `docs` and `script history` also
accept `list` and `ls`. `status` and `catalog` do not.

## Select and deliver resources

```sh
tack pick include SKILL --project PROJECT
tack pick include COMMAND --kind command --project PROJECT
tack pick exclude SOURCE:SKILL --user
tack pick --project PROJECT
tack pick remove SKILL --project PROJECT
tack sync --project PROJECT
tack sync --project PROJECT --apply
tack status --project PROJECT
```

A choice reference is `name` or `source:name`; use `--kind` when kinds clash. The same kind and
name in two sources is a name clash, not an error: both resources load, a bare reference to the
name fails and lists the exact command for each candidate. An explicit `pick include SOURCE:NAME`
wins over a same-name skill that is only selected by default, so one include resolves the clash.
If two default-activated skills share a name and neither is included, or both are, neither is
delivered until one is excluded with `pick exclude SOURCE:NAME`. `status` and `sync` both report
that case as a `selection-collision` diagnostic whose message names that command for each candidate,
and a failed reference keeps `--project` or `--user` in every command it suggests.
New picks store the source registration ID, kind, name and decision. Use exactly one of `--project PROJECT` or `--user` for choice mutations. Removing a choice restores
metadata-driven selection, including opt-in user activation when `user-activation` is omitted. Project choices cannot suppress a global skill,
one the user namespace selects and links at user level. `pick exclude --project` refuses such a
resource with `project-exclude-refused` and records nothing; its Next names
`pick exclude SOURCE:NAME --kind KIND --user`, which turns the resource off everywhere. An exclude
recorded before the user namespace linked the resource stays, and `sync` and `status` warn about it
with `project-exclude-linked-for-user` and the same Next command. Inspect
`status --user` when that explains unexpected availability.

Every pick stores its source, so there is no pick without one: a bare name that matches several
sources fails and lists the command for each candidate. `pick remove NAME` or `pick remove SOURCE:NAME`
removes a stored pick, with `--kind` when kinds clash.

`pick` returns `{ "kind": "choices", "choices": [...] }`, and `adapter` returns
`{ "kind": "adapters", "enabledAdapters": [...] }`. `pick include`, `pick exclude`, `pick remove` and `adapter enable`
return `choice-change`, `choice-removal` and `adapter-settings` payloads.

`tack sync --project PROJECT` previews without writing.
`sync --include-optional` adds optional dependency edges; it does not select every opt-in
skill; inspect the result with `status --include-optional`. `--adapter ID` (`claude`, `cline`,
`codex`, `copilot`, `cursor`, `gemini`, `opencode` or `pi`) limits reconciliation to that enabled
adapter; repeat it to name several. Sync refuses an adapter that is not enabled with
`adapter-not-enabled` and writes nothing: run `tack adapter enable ID` first, so later syncs keep
its links. `--no-adapters` plans docs mounts only, for a project: it cannot be combined with `--adapter`, `--no-docs` or `--user`.
`--require-capability command-links` blocks every plan unit whose adapter cannot link commands.
With no enabled adapter, sync reports `no-adapters-enabled` and delivers nothing.
A project does not link a skill or command that the same adapter links for the user, so agents in
that project list it once. The plan unit names it in `linkedForUser`, the text preview shows it as
`skip … linked for the user`, and a project link made before is removed with the reason
`linked-for-user`; `status` lists it as undelivered with that reason. The plan decides from the
selection, so removing the user pick links it into the project again on the next project sync.
A project resource of another source with the same name is still linked.
Apply a preview with the flags that made it: `--apply` alone widens a `--no-adapters`, `--no-docs`,
`--adapter` or `--include-optional` preview to everything. The plan's `options` echoes the
`--adapter`, `--require-capability`, `--include-optional` and `--no-docs` it was made with (absent
when none was given), and `resources: null` means `--no-adapters`.

| Adapter    | User skills                 | User commands                         | Project skills     | Project commands                |
| ---------- | --------------------------- | ------------------------------------- | ------------------ | ------------------------------- |
| `claude`   | `~/.claude/skills`          | not delivered                         | `.claude/skills`   | not delivered                   |
| `cline`    | `~/.cline/skills`           | `~/Documents/Cline/Workflows/NAME.md` | `.cline/skills`    | `.clinerules/workflows/NAME.md` |
| `codex`    | `~/.agents/skills`          | not delivered                         | `.agents/skills`   | not delivered                   |
| `copilot`  | `~/.copilot/skills`         | not delivered                         | `.github/skills`   | not delivered                   |
| `cursor`   | `~/.cursor/skills`          | `~/.cursor/commands/NAME.md`          | `.cursor/skills`   | `.cursor/commands/NAME.md`      |
| `gemini`   | `~/.gemini/skills`          | not delivered                         | `.gemini/skills`   | not delivered                   |
| `opencode` | `~/.config/opencode/skills` | `~/.config/opencode/commands/NAME.md` | `.opencode/skills` | `.opencode/commands/NAME.md`    |
| `pi`       | `~/.pi/agent/skills`        | `~/.pi/agent/prompts/NAME.md`         | `.pi/skills`       | `.pi/prompts/NAME.md`           |

`copilot` is GitHub Copilot CLI and `gemini` is Gemini CLI. Project paths are relative to each
project root. Pi calls a command a prompt template and Cline a workflow; Tack links the same
Markdown file and translates nothing, so arguments and frontmatter mean what each agent makes of
them. Cline runs a linked command as `/NAME.md`, extension included. Copilot CLI and Gemini CLI get
no commands: Copilot CLI reads Markdown commands only from Claude Code's `.claude/commands`, and
Gemini CLI reads commands only as TOML files. Tack uses only these standard folders: it ignores
`XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` for OpenCode, `PI_CODING_AGENT_DIR` for Pi,
`COPILOT_HOME` for Copilot CLI, `GEMINI_CLI_HOME` for Gemini CLI and `CLINE_DIR` for Cline. Pi
reads a project's `.pi` folders from the folder it starts in, so start it at the project root, and loads
them only once the project is trusted. Several agents read other agents' folders too: Cursor and OpenCode read
`.claude/skills` and `.agents/skills` (Cursor the first only with its third-party configs setting on); Pi, Gemini CLI and Copilot CLI read `.agents/skills`; Copilot
CLI and Cline also read `.claude/skills`. They list a skill reached through several folders once, though Gemini CLI warns of a conflict when the `codex` and `gemini` adapters both link it; `adapter disable` removes
only that adapter's links. Zed, Goose and Amp read `.agents/skills`, so the `codex` adapter reaches
them. An open session may need a restart, or `/reload` in Pi, to see new links. Context has no delivery adapter yet;
`status` reports such selected resources as undelivered, and the sync text view says which agents a
selected command or context does not reach. Delivering a resource makes it discoverable; agent
loading behavior is separate. `status --project PROJECT --details` also prints the project's
`.gitignore` lines: one per link Tack keeps, from the repository root, without a trailing `/`, and,
when docs are attached, the docs mount folder (`/.tack/` by default) with one.

## Import skills from GitHub

An import copies chosen skills from a GitHub location into a source the operator owns. The copy is
an ordinary skill of that source from then on: the operator edits it, and Tack delivers it like any
skill there. `import add` and `import remove` preview by default; `--apply` writes. Nothing is
delivered and no state changes until `sync`.

```sh
tack import add github:ORG/REPO
tack import add github:ORG/REPO --skill pdf --into SOURCE
tack import add github:ORG/REPO --skill pdf --into SOURCE --apply
tack import add github:ORG/REPO --all --into SOURCE:vendor/skills --apply
tack import
tack import remove SOURCE:pdf
tack import remove SOURCE:pdf --apply
tack sync --all
```

A location names its provider: `github:org/repo`, `github:org/repo/folder` or `github:org/repo#REF`
(branch, tag or a full 40-character commit). A URL names its host and is accepted too: an
`https://github.com/...` URL (`/tree/REF/folder`, or `/blob/REF/.../SKILL.md`) or
`git@github.com:org/repo.git`. `github` is the only provider. Bare `org/repo` is refused with the
reason `location-provider-missing`: retype `details.suggestion`, which is the same location with
the `github:` prefix, and never guess a provider. An unknown prefix is `location-provider-unknown`,
a URL on another host is `location-other-provider`, and `@` is refused everywhere
(`location-at-form`; pin with `#REF`). These reasons are in `details.reason` of the
`import-location-invalid` diagnostic. Abbreviated commit IDs, local paths and URLs with credentials
are refused. The preview shows the canonical `github:` location even for a URL, and that is the form
to reuse. Private repositories use the operator's own git credentials;
Tack never reads or stores a token. Folders whose name starts with `_` in the location are not
candidates, and `--full-depth` searches every folder to five levels.

- **Choose skills.** One candidate needs no flag. Otherwise pass `--skill NAME` (repeat for several)
  or `--all`; unknown names fail and list what exists. A candidate that cannot be imported shows
  the catalog's own reason; `--all` skips those and lists them.
- **Choose the destination.** `--apply` requires `--into SOURCE`, a registered, healthy source that
  is not the built-in one (label or registration ID). `SOURCE` uses the source's only declared
  skills folder; with several, or none, the command is refused and names the choices or the
  `skills` entry to add. `SOURCE:FOLDER` names one declared folder, or a group folder inside one,
  which import creates. Tack never adds or edits a declaration: if the folder is outside every
  declaration, excluded by its patterns, not selected by its include patterns, or inside a skill,
  tell the operator which entry to change by hand. A skill name that the source already has, in any
  declared skills folder, is refused.
- **Read the preview.** `plan` holds the candidates and verdicts, the resolved `revision`, the
  `destination`, the `writes` (folder and file counts) and the `reach`: which projects and whether
  the user namespace will receive the skill at the next `sync`, name collisions with another
  source, old picks that would select nothing, and dependencies on sources the destination does
  not declare in `depends-on`. The copy follows the destination's normal activation, so a skill
  without Tack metadata reaches every project at the next `sync`. A project a fixed profile holds
  is listed apart as not delivered, with its profile: the skill reaches it only after the operator
  adds it to that profile and re-applies the profile with the command the preview names. Report the
  reach to the operator before applying.
- **Apply.** It re-resolves the ref, fetches, validates against the live destination and writes
  only `FOLDER/NAME/` and one record in the `imports` section of the destination's `tack.yaml`,
  byte for byte, through a staging folder. An interrupted write is finished or rolled back by the
  next `import add --apply` or `import remove --apply` for that source. The result lists the paths
  written; run `tack sync --all` to preview delivery. A same-name skill in another source
  is allowed and surfaces at `sync` as a `collision`, as when registering a second source with it;
  `pick include SOURCE:NAME` for the one to keep, or `pick exclude SOURCE:NAME`, resolves it.
- **List and remove.** `tack import` lists every imported skill with its location, ref,
  revision and local state: unchanged, locally changed, or folder missing. A location reads
  `<provider>:<text>`; a record whose provider this release does not know still lists and removes. Local edits are
  allowed. `import remove SOURCE:NAME --apply` deletes the folder and its record; a locally changed
  folder is refused until `--force`, which deletes the edits too, and Tack keeps no copy. The next
  `sync` removes the links. `import`, `import remove`, `source`, `catalog`, `status` and `doctor`
  work offline; only `import add` fetches.

`status` and `doctor` report an imported skill whose folder is gone (`import-folder-missing`), one no
`skills` entry covers (`import-folder-not-cataloged`), an `imports` section Tack cannot read
(`imports-invalid`) and a leftover staging folder (`import-staging-left-over`); local edits are only
counted. Import failures are `invalid-configuration` for a request the operator can repair, and `domain` for
a fetch that failed (network, authentication, a ref or revision the remote does not serve) or a
write that changed nothing. Never edit the `imports` section by hand.

## Attach documentation

Declare documentation in the registered source's top-level `tack.yaml`:

```yaml
version: 1
name: team-knowledge
skills:
  - path: skills
docs:
  - name: handbook
    path: knowledge
```

The path is source-relative. Plain Markdown needs no frontmatter or reader configuration. The
`manage-tack-sources` skill owns the declaration model: the optional `reader` key, and the rule that
a `tack.yaml` with `docs` and a folder named for another kind also needs that kind's key
(`skills: []` when the folder is ordinary content, as the example shows with a `skills` entry).

```sh
tack docs attach handbook --project PROJECT
tack docs configure --project PROJECT --default handbook
tack sync --no-adapters --project PROJECT
tack sync --no-adapters --project PROJECT --apply
tack docs target --project PROJECT
```

A docs resource is identified by source registration ID and name. Use `source:name` when the name
is ambiguous; the source can be its label or registration ID.
`docs configure --destination RELATIVE_PATH` changes the project-relative destination base; like
every `docs` command except `docs icons` it takes `--project PROJECT` or the registered project
containing the current directory or `--cwd PATH`. A destination that is absolute or leaves the
project root fails with `docs-destination-invalid`. Reconcile afterward.

`docs search` matches every query term, case-insensitively, across saved content and paths. The query
is at most 512 characters, `--limit` is 1 to 50 and defaults to 10, and `--type`, `--status` and
`--tag` filter on exact metadata. A project with no attached docs is incomplete, with `complete:
false` and a `setup` object naming the `tack docs attach` command that closes the gap.

Write files, run `tack check PATH...`, and repeat until clean. It detects source folders,
profile YAML files, content bundles and Markdown docs without state or a browser. Include
companion source folders for cross-source profile linkage. Source folders include their resources,
published profiles and docs figures. Findings have file:line locations; errors exit 1, warnings
exit 0. Figures, icons and author components use the reader's static rules without running a page. Unknown icons produce `icon-unknown`; misused components produce `component-issue`. Computed props produce
`figure-not-checked`; unavailable inputs produce `check-path-unavailable`. A folder of skills
without `tack.yaml` produces the warning `check-not-a-source` and gives the same advice as a bare
`tack source add PATH`: a JSON declaration for `--config` read from its layout, a skills entry `.`
for skill folders at its top or one entry per folder named after a kind, and the folder above for
a `SKILL.md` at PATH. The
`write-reader-figures` skill teaches figure authoring.

`tack docs icons [WORD]` lists the Lucide icons a document may draw with `<Icon name>`, by category,
with the Lucide version they come from; a word filters names, categories and old Lucide names. It
needs no project. Pick names from it rather than from memory.

Detach with `tack docs detach handbook --project PROJECT`, then preview and
apply docs reconciliation. Detaching the default writing resource clears the default. Use
`tack docs configure --project PROJECT --clear-default` to clear it without detaching.

## Run scripts

```sh
tack catalog --kind script
tack script show report
tack types /path/to/source --apply
tack script run report --project PROJECT -- --name Ada --times 2
tack script run report --project PROJECT --input-json '{"name":"Ada"}'
tack script history
tack script history show RUN_ID
tack script history clear
tack script history clear --apply
```

A source declares scripts in its `tack.yaml` (see `manage-tack-sources`). A script reference is
its declared `name`, qualified with `source:` when ambiguous. A run has exactly one target: `--user`, `--project PROJECT` (one active root only), `--root PATH`, or the deepest
registered root containing the current directory or `--cwd PATH`. `script show` lists the
arguments and secrets a script declares; it loads the script but never runs it. Pass arguments
after `--`, as `--name value`, `--name=value`, `--flag` or `--no-flag`, repeating a list argument;
or pass one JSON object with `--input-json`, `--input-file` or `--input-stdin`, never both. Every
argument problem is reported at once (`invalid_args`). With none, Tack supplies `{}`. `types`
previews, and with `--apply` writes, a source's editor types for its scripts (see
`manage-tack-sources`). `--timeout MS` is
a positive integer in milliseconds that interrupts the run, and `--quiet` stops mirroring script
logs to standard error while the result and history keep them. The source supplies its own
dependencies, so only `script run` finds a broken script. Run outcome codes use snake_case, unlike the
kebab-case codes of other diagnostics. A run returns a `script-run` payload and `script history` a
`run-history` payload. Every run leaves a history record; `script history clear` previews how many records
`--apply` deletes.

## Upgrade Tack

```sh
tack upgrade
tack upgrade status
```

Tack never upgrades itself. `upgrade` and `upgrade status` are the same read-only report: the
running version, how Tack was installed (`npm`, `bun` or `source`) and the command that upgrades
it, such as `npm install --global @tackup/cli@latest`; a source checkout upgrades by pulling. Running
the command is the operator's decision. Afterwards, `tack init` relinks the built-in skills to the
new version.

## State format

This release reads and writes state format 1 only, under the envelope key `format`.
`state-format-unsupported` means a newer Tack wrote the state file: `tack upgrade` names the command
that installs it.

## Maintain and remove managed links

```sh
tack project refresh --project PROJECT
tack project refresh --project PROJECT --apply
tack project refresh --all
tack state clean --project PROJECT
tack state clean --project PROJECT --apply
tack state clean --pending --user
tack state clean --pending --user --apply
tack adapter disable cursor
tack adapter disable cursor --apply
tack source remove SOURCE
tack source remove SOURCE --apply
tack project remove PROJECT
tack project remove PROJECT --apply
tack state reset
tack state reset --apply
```

Refresh updates registered worktrees and their managed resources. A new worktree has no links: from
it, `tack project refresh --apply` adds its root, then `tack sync` previews its links. Until then,
`status --project PROJECT` there warns with `worktree-not-registered`. `state clean` removes managed resource
and docs links for the selected scope while retaining configuration. `state clean --pending` retries pending removals, which agent links and docs mounts both owe when a removal could not be made safely. Adapter
disablement previews cleanup before changing the enabled adapter list: its scope is every project
and the user target, and after `--apply` run `tack status --all`. Every cleanup view counts its
actions per adapter and target, such as `cursor → app (3 roots) · 36 to remove`, then lists the
first 10 actions; `--details` lists them all. `source remove` and
`project remove` preview the cleanup and the intent they delete before unregistering; a project
whose link stays blocked keeps `removal requested` until a second `--apply` or
`state clean --pending` settles it. `state reset` previews removal
of all managed links and state; `reset --apply` finalizes only after cleanup settles. Use it only
when explicitly asked.

Exit codes are `0` for success, `1` for partial or domain failure, `2` for invalid invocation or
configuration, `3` for persistence or internal failure, and `130` for interruption. Do not treat a
nonzero exit as evidence that no changes occurred.

An `internal-error` hides its cause. Its next step reruns the same command with `TACK_DEBUG=1`
before it, which writes the full cause and the failing use case to standard error. Put that text in
the bug report; the command's output does not change.

## Check a fixed profile

`tack check PROFILE_FILE [COMPANION_SOURCE...]` reports a source-published manifest and its required
closure without writes or execution. Use `author-tack-profiles` to create or repair it.

For fixed target deployment, preview `tack profile apply SOURCE:PROFILE --project PROJECT --target-root /absolute/project`, then add `--apply` after review. Use `author-tack-profiles` for complete roots, isolated user contexts, replacement guards and retained inventory.

Profiles can copy membership without changing the daily workflow's meaning. Preview
`tack profile save /path/to/source NAME --project PROJECT` (user + one project by default), or
use `--input user` / `--input project --project PROJECT`. `--apply` saves only the profile;
`--edit` explicitly updates an existing one. Browse offers origin review and individual adjustment
before source/name choice and final file/publication review. Preview
`tack profile adopt SOURCE:PROFILE --project PROJECT` (or `--user`); `--apply` writes ordinary
includes and project docs attachments without sync, preserving unrelated picks. Profile edits do
not subscribe daily selection. Fixed contexts and user-only docs refuse. See `author-tack-profiles`
for copy walkthroughs and the distinct exact-application contract.

Preview `tack profile export SOURCE:PROFILE /artifacts/profile.tar.gz`; `--apply` writes a new
content artifact after file/support/prerequisite review. `tack profile inspect-bundle FILE` reads
the inventory; `tack check FILE` validates offline without state or original sources. Preview
`tack profile apply-bundle FILE --project PROJECT --target-root /repo`, then add `--apply` after
review. It retains verified source projections and registers fresh local identities before fixed
delivery; no original sources or prior ordinary sync are required on a fresh dedicated target.
Complete-root/user isolation, existing-selection force and foreign protection match source apply.
No supplied code, package hook, installer or network fetch runs. Use `author-tack-profiles` for
support declarations, pristine setup, artifact bounds and immutable retained-content repair.
