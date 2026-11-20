---
name: tack-git
description: Use when about to manipulate Git in the Tack project.
---

# Tack Git

Keep Tack branches linear.

- Update branches with rebase. Use `git pull --rebase` when pulling remote changes, and
  `git rebase <base>` when bringing a base branch into a feature branch.
- Integrate changes with a fast-forward merge (`git merge --ff-only <branch>`) or a squash merge.
- Never create merge commits. If a fast-forward is not possible, rebase first or squash the changes.
