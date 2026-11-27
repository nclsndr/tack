<p align="center">
  <img src="apps/website/docs/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">Tack</h1>

<p align="center"><strong>One setup. Every agent, project and worktree.</strong></p>

<p align="center">
  Combine your own skills and docs with your team's, from as many repositories as you keep. Tack
  links them into every project and worktree, for each agent you use, and shows the plan before it
  writes.
</p>

<p align="center">
  Claude Code, Codex, Cursor, GitHub Copilot CLI, Gemini CLI, Cline, OpenCode and Pi today.
</p>

<p align="center">
  <a href="https://tackup.dev/docs/getting-started">Get started</a> ·
  <a href="https://tackup.dev/docs/">Docs</a> ·
  <a href="https://tackup.dev/features">Features</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Why Tack

A team's skills end up copied into each repository, each worktree and each laptop, and never reach
the CI runner. Working alone, you copy the same skills into each project and each new worktree, or
write a link script that covers one folder. You fix one copy and the others drift.

Tack combines your own sources with your team's into one setup. It keeps one copy of each skill,
where you maintain it, and links it where it is needed: into the agent each teammate uses, into every
project and worktree you register, and onto a CI runner or a remote agent from one bundle file.

## What Tack manages

| You write | What your agents get                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| Skills    | A link in each agent's skills folder, for you across every project or for one project.                              |
| Commands  | A link in the commands folder of Cursor and OpenCode, in Cline's workflows and in Pi's prompts folder.              |
| Docs      | A mount at `.tack/docs` in every worktree, a local browser reader and `tack docs search`.                           |
| Scripts   | `tack script run NAME` in any registered project, with only the secrets the script declares and a run history.      |
| Profiles  | An exact, reviewed set of resources for a project or a remote agent, carried to another machine in one bundle file. |

Apart from `tack init`, which sets Tack up, every command that changes links shows its plan first
and writes nothing until you add `--apply`. [Features](https://tackup.dev/docs/features) lists
everything Tack does, and what it does not do yet.

## How Tack compares

A link script covers one machine, one repository and one agent folder. With one repository and
agents that all read `.agents/skills`, a committed folder needs no tool at all. Tack is for the step
after: your skills and your team's in several repositories and worktrees, a different set for each
project, agents that read different folders, and a CI runner.
[Tack and the other ways to share agent skills](https://tackup.dev/docs/compare) compares it with
the `skills` CLI, skillshare, rulesync, APM and dotagents, and says when another one fits better.

## Install

```sh
npm install --global @tackup/cli
```

Tack runs on macOS and Linux, with Node 22.12 or later or with Bun. Then follow
[Get started](https://tackup.dev/docs/getting-started) to register your setup and link it into a
project, step by step or with one prompt to your coding agent.

Not sure what to do next? Run `tack doctor`. It checks your setup and ends with the commands to run.

## Documentation

The documentation lives on [tackup.dev](https://tackup.dev/docs/):

- [Get started](https://tackup.dev/docs/getting-started): install Tack and link your setup into a
  project.
- [Agent support](https://tackup.dev/docs/agent-support): the folders each agent reads, and what it
  gets.
- Guides for each task, such as [adding a source](https://tackup.dev/docs/guides/add-a-source),
  [onboarding a team](https://tackup.dev/docs/guides/team-onboarding),
  [linking docs](https://tackup.dev/docs/guides/link-docs),
  [running a script](https://tackup.dev/docs/guides/run-a-script) and
  [sharing a fixed set with a profile](https://tackup.dev/docs/guides/profiles).
- The reference: [setup, state and upgrades](https://tackup.dev/docs/reference/setup),
  [the source format](https://tackup.dev/docs/reference/tack-yaml),
  [projects and selection](https://tackup.dev/docs/reference/selection),
  [sync and status](https://tackup.dev/docs/reference/sync),
  [docs and the reader](https://tackup.dev/docs/reference/docs),
  [scripts](https://tackup.dev/docs/reference/scripts),
  [profiles and bundles](https://tackup.dev/docs/reference/profiles),
  [skill imports](https://tackup.dev/docs/reference/import) and the
  [automation contract](https://tackup.dev/docs/reference/automation).

The [glossary](CONTEXT.md) defines source, resource identity, scope and activation.

## Contributing

Tack is a Bun and Effect monorepo. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up a
checkout, run the checks and open a pull request. Report security issues privately, as
[SECURITY.md](SECURITY.md) describes.

## License

MIT, see [LICENSE](LICENSE).

<p align="center">
  <strong>Change agents. Keep your setup.</strong><br>
  Tack up any agent.
</p>
