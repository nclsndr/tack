---
name: use-tack
description: Operate Tack, which manages cross-agent skills, commands, context, docs and scripts. Use for any `tack` command - discover resources, pick and sync them into Claude Code, Codex, Cursor, GitHub Copilot CLI, Gemini CLI, Cline, Junie, OpenCode or Pi, attach and search docs, run declared scripts, check health and upgrades. To create or edit a source, use the `manage-tack-sources` skill.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: default
---

# Use Tack

Tack manages cross-agent resources from registered sources: skills, commands, context, docs, and
scripts. It links selected skills and commands into supported agents and attaches docs to projects.
Source files stay in their original directories.

First-time setup, or a request to set up Tack: run `tack guide onboarding` and follow it. `tack guide`
lists every guide; each prints the guide of the running version and needs no setup.
At the start of work in a repository that uses Tack, the `prepare-tack-checkout` skill makes its
skills present.

## Output

Tack prints a compact text view by default. Read it for ordinary work. The
first line names the command and its status (`✓ success`, `! partial` or `✗` with the failure
class), diagnostics name what went wrong with a code, and a `Next` section lists the exact commands
to run next. Follow `Next` before guessing a command. A `partial` status, which exits `1`, means the
command ran and something needs attention, such as an unhealthy link: it is not a Tack failure.
`tack --help` is the operation map and `tack PATH... --help` gives one command's flags; this skill
does not repeat them. Text views change in any build: read them, never parse them.

Use the text view by default. Add `--json` after `tack` when you need exact state fields (selection,
link state, plan actions) or the task asks for a structured answer. It prints the version 1
envelope: `status`, `classification`, `diagnostics`, `next` (the commands the text view lists),
`plan`, `applied` and `result`. Only `status`, `sync`, `init`, `doctor`,
`upgrade` (with `upgrade status`) and `--version` carry a stable payload (`--version` is the fixed
`kind: "version"` object). Every other command, including `import`, prints JSON with no schema:
never script against its shape.
In `status --json`, a healthy link has `_tag: "matching"`; every other `_tag` needs attention, and
`expected-absent` means a link is expected and missing. `--format` is gone and `TACK_FORMAT` has no
effect.

`tack explore` is the operator's interactive editor and fails with `terminal-required` without
a terminal or under an agent. Inspect resources and health with `tack catalog` and `tack status`,
and change picks with `tack pick`; `tack catalog` only reports.
In `tack explore`, `d` chooses browse only, user selection, project selection or profile editing
inside the window.
Use `author-tack-profiles` for fixed manifest authoring/checking, independent copies, explicit
applications and portable content bundles.

## Stay in scope

Do only what was asked: do not attach, mount, pick or sync beyond the request, and preview before
any change. Go straight to the command the task needs. Use `--help` only for that command, and skip
broad inventory sweeps of `catalog`, `source`, `project`, `adapter` and `doctor`, except during
onboarding.

## After a change

A new project, worktree, clone, source, skill, script or docs after setup: `tack guide day-two`
names the commands for each.

## Find the right resource

Read-only commands, each for the fact the task needs: `tack catalog` (resources and validation
issues), `tack doctor` (machine-wide health with the exact next command), `tack source`,
`tack project`, `tack adapter`, `tack import`, `tack status --project PROJECT` or `--user`,
`tack catalog --kind script`, `tack script history`, `tack docs --project PROJECT`,
`tack docs search "QUERY" --project PROJECT --limit 5` and `tack docs target --project PROJECT`
(the verified destination for writing documentation). `--help`, `--version` and `doctor` work
before Tack is set up and change nothing. `upgrade` names the running version and the command that
upgrades it.

`source` shows each source's declarations: kind, path, patterns, resource count and problems.
`catalog --details` adds the declared path that found each resource.

Search returns bounded excerpts with physical source paths and line ranges. Read the cited files
before relying on their contents or editing them. Check `complete` and `issues` (add `--json` when
the text view hides them): an incomplete search does not show that a result is absent. Narrow with
`--type`, `--status` or `--tag` when the project uses those metadata fields.

Write documentation to the verified `destinationPath` from `docs target`. It resolves to the
attached source, so other projects attached to that source share the change. With no default
writing resource, inspect `docs` and select one with `--name SOURCE:NAME` (the source is its label
or registration ID). An absent or redirected mount needs repair; write only to the verified
destination. `tack docs serve --project PROJECT --no-open --port 0` prints a local reader URL, then
stays in the foreground until interrupted, so run it in the background.

## Executable, state, and scope

Find the executable once per session and keep it: `tack` if `command -v tack` finds it. If there is
none, report exactly: "Tack is not installed: no tack on PATH. Install it with npm install --global
@tackup/cli." Installing Tack is the operator's decision.

Tack never upgrades itself: `tack upgrade` names the command that does, such as
`npm install --global @tackup/cli@latest`. Run it only when the operator asks, or when a command
the task needs is missing and the operator agrees. After a package upgrade, `tack init` points the
built-in skills at the new version.

`tack init` sets up a machine at once, with no preview and no `--apply`: the state, the agents it
finds in the home (`~/.claude`, `~/.cline` or `~/Documents/Cline`, `~/.codex` or `~/.agents`,
`~/.copilot`, `~/.cursor`, `~/.gemini`, `~/.junie`, `~/.config/opencode`, `~/.pi`) and the user links of
`sync --user` for them, which on a new machine are the built-in skills. It prints what it wrote.
`--adapter ID`, repeatable, replaces detection; init never disables an adapter. It lists the
hand-made entries in those agents' user folders and leaves them untouched, and never touches
sources, projects or picks. It is safe to repeat: a rerun on a set-up machine writes nothing.

Source runs of a Tack checkout (branch, clone, worktree) use `bun run --cwd <checkout> tack ...`
with an isolated `TACK_STATE_DIR` or `--state-dir`, so testing Tack itself never touches the
installed Tack's state. State defaults to
`~/.tack`; `TACK_STATE_DIR` selects another location and a root `--state-dir PATH` wins over it.
Keep one state directory throughout a workflow.

Pass an explicit selector: `--project PROJECT` for a registered project (its name, never a path;
`tack project` lists the names), `--user` for the
user-level target. Never combine selectors, or pair one with `--cwd`. A request to add a skill "for
me", "everywhere" or "globally" means `--user`: user-level links reach every project's agent
sessions.

Without a selector, `sync`, `status`, `state clean`, `state clean --pending` and `project refresh`
select the project containing the current directory or `--cwd PATH`, with its active roots and
pending removals (`project refresh` also finds a registered project through the worktree's Git
directory). Outside a project a bare request fails: do not add `--all` in response; follow its Next
(`project refresh --apply` in a new worktree, `project add NAME` in an unregistered repository), or
inspect the registrations and pass `--project PROJECT`, or report the failure. `--all` selects every project and the user target (every project
only, for `project refresh`); use it only when the operator asks for every project by name or number,
such as "every project and my user links".

Built-in skills ship with Tack, are delivered by `sync` like any default skill, and are locked in
`tack explore` at both user and project scope.
`pick include`, `pick exclude` and `pick remove` refuse them with `builtin-skill-locked`.
Profile saves omit built-in skills. Explicit built-in members produce a checker warning and are skipped with a note by profile adopt/apply; built-in delivery stays independent.

`tack explore` opens the project that contains the current directory, or else the destination
chooser; `--user` or `--project PROJECT` opens that selection. In a selection, each row shows whether that destination gets the
resource and why (`● default`, `● included`, `● dependency`, `○ excluded`, `○ opt-in`, `✗ blocked`,
`locked`), and a staged change follows it, such as `● default → include`. A project row ends with
`· via user` when the user scope delivers it; agents in every project load user resources. A
project that a fixed profile owns is read-only: rows show `● member`, `● required` or
`○ not a member`, and staging keys point to the profile. The detail pane groups the state as `user`,
`projects` and `profiles`, marks the edited one with `›`, and says where each state comes from. `i` includes a choice, `x` excludes it and `a`
attaches or detaches docs. Each key toggles: the key that staged a change unstages it, and the
detail pane and footer name what each key does next. `u` unstages a row and `r` stages the removal
of its saved pick so the source default applies again. Source and folder rows stage every descendant: the key
stages the descendants that lack its value, and once all have it the same key unstages them. On a
group already saved that way, `i` or `x` resets choices to declarations and `a` detaches docs.
Folded and filtered-out descendants are included; built-ins and resources that cannot take the
action are skipped. Counts show all/some/none using staged values. `c` previews each child's
change before confirmation writes. In a profile or save-selection destination, `i` includes members
and `x` excludes them with the same toggles; built-ins stay locked out of membership.

To enable and deliver a registered skill: `tack pick include SOURCE:NAME --project PROJECT`, then
`tack sync --project PROJECT` to preview, then the same command with `--apply`. A preview that plans
nothing usually means the skill is not picked yet.

Read the first line and the unit headings of a `sync` preview, and state its selector and targets in
your reply before you apply. A bare request names the containing root it resolved.

[references/operations.md](references/operations.md) covers setup, selection, importing skills from
GitHub, docs attachment, scripts, upgrades and cleanup. The `manage-tack-sources` skill owns creating, changing and
registering a source: the `tack.yaml` declaration and resource metadata. Its worked-source
reference pairs complex declarations with dependency metadata and name-clash fixes.

## Changes and verification

For authoring, use one loop: write files, run `tack check PATH...`, and repeat until clean.
It detects source folders, profile files, content bundles and Markdown docs. A source check includes
its resource declarations, profile definitions and docs figures. Pass companion source folders
in the same invocation for cross-source profile linkage; no state or registration is read.
Findings use file:line locations; errors exit 1 and warnings exit 0. The JSON report is not stable.
`profile inspect-bundle` reads contents; `tack check` performs full validation.
Doctor also reports broken published profiles that have never been applied.

`sync`, `project refresh`, `project remove`, `source remove`, `adapter disable`, `state clean`, `state reset`,
`script history clear` and `types` preview by default: inspect the plan, then add `--apply` within the scope of the
requested task. `sync --no-adapters` plans only docs mounts; `sync --no-docs` plans only resource
links.

`import add` and `import remove` preview by default too; their `--apply` writes into the requested source, never state. `source add` registers a source that has `tack.yaml` immediately. For a folder without one, its `--skills`, `--commands`, `--context` and `--docs` flags preview the `tack.yaml` it would write, and `--apply` writes it and registers the source after state initialization. Other registrations, choices, adapter settings, and docs attachment and
configuration persist immediately, without `--apply`, and so does `tack init`. `tack script run` executes immediately.

The printed view is the result: check the status on its first line, the diagnostics and the `Next`
commands. A partial operation can change healthy targets while another target fails. Each partial
diagnostic has a specific `code`, such as `no-adapters-enabled`, `root-missing` or a `docs-*` cause
for a docs link that cannot proceed.

Read the reason beside each planned removal before applying. `deselected` follows the operator's
choices, and `linked-for-user` removes a project's link to a resource the user's folder already
has. `source-unhealthy` (the registered source cannot be read) and `quarantined` (the
resource's own file no longer validates) mean a broken file, not a choice: fix it with
`tack check <source-path>` instead of applying the removal.

A link whose removal could not be made safely stays on disk as a pending removal, for a docs mount
as for an agent link. Retry with `state clean --pending` for the same scope once the cause is fixed.

After applying, run `status` for the same scope; after a docs change, also check the mount with
`docs target` when it is meant for writing. Fix the reported cause and retry the affected scope.
Leave foreign files and drifted links in place: Tack's ownership evidence decides which paths it may
remove. A recorded link changed outside Tack whose resource is no longer selected (`status` tag
`evidence-changed`) is released by `sync --apply`: Tack forgets the record and keeps the link. A
file or folder that was at a destination before Tack linked there is `hand-made`: Tack keeps it,
links everything else, and `doctor` only warns. `project add` lists the hand-made entries in a new
project's agent folders before anything is linked. Ask the operator whether to keep theirs with the
`tack pick exclude` that `doctor` names, which unlinks Tack's resource for every agent of that
project, or to move theirs away and sync.
`tack state reset --apply` answers only an explicit request to remove all Tack-managed links and
state.

Choices accept `skill`, `command` and `context`. Every adapter links skills, Cline, Cursor, Junie,
OpenCode and Pi also link commands, and context has no delivery adapter yet. Scripts run by reference with
`tack script run`, and docs use the attachment workflow.
