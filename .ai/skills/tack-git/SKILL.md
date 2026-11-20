---
name: tack-git
description: Use when about to manipulate Git in the Tack project.
---

# Tack Git

Keep Tack branches linear.

- Name branches `<type>/<name>`, where `<type>` is a
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) type that CI accepts:
  `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `build`, `chore` or `revert`.
- Write commit messages that follow
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

- Update branches with rebase. Use `git pull --rebase` when pulling remote changes, and
  `git rebase <base>` when bringing a base branch into a feature branch.
- Integrate changes with a fast-forward merge (`git merge --ff-only <branch>`) or a squash merge.
- Never create merge commits. If a fast-forward is not possible, rebase first or squash the changes.
