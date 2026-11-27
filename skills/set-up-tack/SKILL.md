---
name: set-up-tack
description: Install and set up Tack (@tackup/cli, tackup.dev), the CLI that links skills, commands and docs from folders and Git repositories you own into Claude Code, Codex, Cursor, Copilot CLI, Gemini CLI, Cline, OpenCode and Pi, in every project and Git worktree. Use when asked to share skills between coding agents, to link one skills folder into .claude/skills, .agents/skills or .cursor/skills, or to install Tack.
---

# Set up Tack

Tack is an open-source CLI that combines the agent skills, commands, docs and scripts in the folders and Git repositories you and your team own into one setup, links it into every coding agent, project and Git worktree, and shows every change before it writes.

1. Run `tack --version`. When `tack` is missing, install it with `npm install --global @tackup/cli`. It needs Node 22.12 or later, or Bun.
2. Run `tack guide onboarding` and follow the guide it prints. It is written for the installed version, so it, not this skill, decides each later step.
3. Show the person each preview, and add `--apply` only after they agree.

Once `tack init` has run, every enabled agent has Tack's own skills, `use-tack` among them, for daily use. The docs are at https://tackup.dev/docs/.
