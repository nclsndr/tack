# After setup: add a project, a source or docs

Show the previews of a change together and wait for the person's yes before `--apply` (worker mode:
your instructions are the approval). Name every command that writes at once before you run it.

## A new project

From inside the repository: `tack project add NAME` (writes at once, links nothing), then
`tack sync --project NAME` and, after the yes, `--apply`. Report the hand-made entries
`project add` lists; they stay in place. Then offer the Tack section for the project's `AGENTS.md`:
run `tack guide agent-instructions` and follow it. Ask whether the links are committed or
ignored; Tack never edits `.gitignore`. `tack status --project NAME --details` prints the ignore
lines under "For .gitignore in project NAME".

## A new worktree or clone

Follow the `prepare-tack-checkout` skill. Without it, from the new worktree:
`tack project refresh --apply`, then `tack sync` and `tack sync --apply`. A clone is a separate
repository: register it with `tack project add NAME` under a new name first.

## A new source

Declare and register it with the `manage-tack-sources` skill. Then `tack sync --all`, and `--apply`
after the yes: the source's default skills reach every project.

## A new skill, script or docs in a registered source

- Skill: write it inside a declared skills folder, run `tack check PATH` (no path checks the current folder), then `tack sync --all`. An edit to an existing skill needs no sync: the links
  point at the source. A project that ignores its links needs a line for each new link: show the
  new lines from `tack status --project NAME --details`.
- Script: follow `manage-tack-sources` (its scripts reference). Scripts run by reference and need
  no sync.
- Docs: declare them with `manage-tack-sources`, then `tack docs attach NAME --project PROJECT`,
  `tack sync --no-adapters --project PROJECT` and `--apply`.

## A skill everywhere

`tack pick include SOURCE:NAME --user` (writes at once), then `tack sync --user` and `--apply`.
A project that also selects the skill keeps no link of its own: its sync preview shows the skill as
`skip … linked for the user`, and removes a link the project already had.
