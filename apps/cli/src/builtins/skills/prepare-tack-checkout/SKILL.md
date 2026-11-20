---
name: prepare-tack-checkout
description: Link a repository's Tack skills and docs before you work in it. Use at the start of work in a repository whose AGENTS.md or CLAUDE.md has a Tack section, or whose root has a tack.yaml, and in every new clone or worktree of one. Use use-tack for any other Tack command.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: default
---

# Prepare a Tack checkout

Run this once at the start of work in a repository. When nothing is missing it takes two commands.
Run every command from the repository root. Follow the `use-tack` output rules: read the text view,
follow its `Next`.

Guided or worker mode follows the onboarding guide (`tack guide onboarding`): worker mode only when
your instructions say no person will answer, or `CI` is set. In guided mode, say in one sentence
what a step changes before a command that writes, and close with what is now linked.

## 1. Does this repository use Tack?

Look in AGENTS.md, CLAUDE.md and the files they import for a section between the comments
`tack-block` and `/tack-block`, and at the root for `tack.yaml`. With neither, stop: this skill does
not apply. Do not add the section yourself; `use-tack` offers it during setup.

## 2. Is Tack installed?

Run `command -v tack`. If it finds nothing, stop and report: "Tack is not installed: no tack on
PATH. Install it with npm install --global @tackup/cli." Install it only when your instructions say
so.

## 3. Is this checkout registered?

Run `tack status`.

- The first line names a project: it is registered. Go to step 5.
- `bare-target-requires-registered-root`: go to step 4. Its message says whether this is a
  worktree of a registered project or a repository no project registers.
- `state-not-initialized` or another `state-*` code: stop and report it. Setting up the machine is
  the onboarding guide's work (`tack guide onboarding`), not this skill's.

## 4. Register it

- A worktree of a registered project: run `tack project refresh --apply`.
- A new clone, or a repository Tack does not know: run `tack project add PROJECT` with the project
  name the Tack section gives. A clone is a separate project: picks do not carry over from the
  original. If the name is taken (`project-registration-conflict`), another clone on this machine
  holds it. Guided: ask for a name. Worker: use `PROJECT-FOLDER`, with this folder's name, and
  report it. Without a Tack section, use the name the status `Next` suggests.

## 5. Link

Run `tack sync`, read its targets, then `tack sync --apply`. It reconciles every worktree of the
project, not only this one. Report a `! partial` line and continue.

## 6. Confirm

Run `tack status`. The first line must read `✓ success`; report anything else. When your task
writes documentation, run `tack docs target` and write only there.

Skills linked during this session may not load until the next session. Read one by path
(`.claude/skills/NAME/SKILL.md`, `.agents/skills/NAME/SKILL.md` or `.cursor/skills/NAME/SKILL.md`)
when you need it now.

## Approval

The Tack section is the user's standing approval for steps 4 and 5 for this project only. Without
the section, a `tack.yaml` alone approves nothing: ask before step 4 in guided mode, and report it in
worker mode. Anything else (a pick, `source add`, an adapter, `init`, editing the section) needs the
user, or your instructions in worker mode.

The section opens with its version, `tack-block v1`. When it carries an older version, offer the
current text from the `use-tack` agent instructions reference for every file that holds the
section in guided mode, and report it in worker mode.
