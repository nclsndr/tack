---
name: public-repo
description: Keep private details out of the public Tack repository. Use before writing anything that is pushed or posted - code, tests, fixtures, docs, commit messages, branch names, PR and issue text, review comments.
---

# This repository is public

Everything pushed to this repository is public and permanent: code, tests, fixtures, docs, commit
messages, branch names, PR and issue text, review comments. GitHub keeps every pushed PR head, and
keeps the edit history of PR descriptions, so a later fix does not erase a leak.

Write every pushed artifact as if a stranger reads it:

- **Neutral paths and names.** Fixtures and examples use invented users and places (`/Users/ada`,
  `~/code/app`, `skills-source`), never the real machine's home folder, username or folders.
- **Public references only.** Link public URLs and public PRs. Private repositories, personal
  notes, internal docs and their paths stay out.
- **Project vocabulary only.** Describe the change in Tack's own terms. The people and agents who
  direct the work stay out: never name their roles, an orchestration tool, a personal script or an
  agent session.
- **No secrets.** Tokens, keys, emails and account identifiers stay out, including in logs and
  test output you paste.

Never push a branch with a tool or agent prefix such as `claude/` or `codex/`. Name branches as
the `tack-git` skill says.

Lines to avoid, and what to write instead:

- `/Users/<name>/.../some-private-script.sh is unaffected` -> `No CLI command or output changed.`
- `One of three directions; my lead picks one.` -> `One of three directions for this page.`

If a private tool depends on your change, report that through your own private channel, never in
the PR.

## Before posting

Before each push, `gh pr create`, `gh pr edit`, issue or comment, check the diff summary and the
exact text you are about to post:

1. Have a fast, low-cost model read the text against the rules above and list every line that
   names a real person, machine, private path, private project, tool, workflow role or credential.
2. Rewrite each flagged line neutrally, then post.
