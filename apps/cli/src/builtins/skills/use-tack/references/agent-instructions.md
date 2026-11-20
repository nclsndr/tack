# The Tack section in a project's agent instructions

The section tells agents in a new clone or worktree of the repository to link its Tack skills
before they work. Agents load the instructions file at the start of every session, so the section
names the `prepare-tack-checkout` skill, which holds the steps.

## When and how to offer it

Offer it once per project, after its first sync. It is the user's file: show the exact text, say
what a yes means, and write it only on yes. Show the change after you write it. Never commit it.
Worker mode: write it only when your instructions say so; otherwise list it in your report.

A yes is the user's standing approval for the section's commands (`tack project refresh --apply`,
`tack project add` for a new clone, `tack sync --apply`) for this project only. Agents in a new
checkout then run them without asking. Everything else still needs the user.

## Which file

- Only `AGENTS.md` exists: write it there.
- Both exist and `CLAUDE.md` imports `AGENTS.md` (a line `@AGENTS.md`): write it to `AGENTS.md`
  only. Claude Code reads it through the import; a second copy would load twice.
- Both exist otherwise: write it to both. Claude Code reads `AGENTS.md` only when there is no
  `CLAUDE.md`, or when `CLAUDE.md` imports it, so the other agents read `AGENTS.md` and Claude Code
  reads `CLAUDE.md`.
- Only `CLAUDE.md` exists: ask whether to add it to `CLAUDE.md`, or to create `AGENTS.md` with the
  section and add the line `@AGENTS.md` to `CLAUDE.md`.
- Neither exists: create `AGENTS.md`, after asking; Claude Code reads it while there is no
  `CLAUDE.md`. Never create `CLAUDE.md`.

Do not touch `.cursor/rules`. Replace an existing section between the same comments; never add a
second one to a file.

## The section

Write exactly this, with `PROJECT` replaced by the project name:

```md
<!-- tack-block v1 -->

## Tack

This repository's agent skills and docs come from Tack (project `PROJECT`). Before you work in a
new clone or worktree, load the `prepare-tack-checkout` skill. Without it, run from the
repository root: `tack project refresh --apply`, then `tack sync` and `tack sync --apply`. In a
clone Tack does not know, run `tack project add PROJECT` first. If `tack` is missing, tell the
user: it installs with `npm install --global @tackup/cli`.
<!-- /tack-block -->
```

The section names no path of this machine, so it is safe to commit. A new release may change the
version in its first comment; `prepare-tack-checkout` then offers the new text.
