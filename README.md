<p align="center">
  <img src="apps/website/docs/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">Tack</h1>

> [!WARNING]
> Tack is under active development and is not yet published to npm.

<p align="center"><strong>One setup. Every coding agent.</strong></p>

<p align="center">
  Write your agent setup once, in a folder you own or share: skills, commands, context, docs and
  scripts. Tack links it wherever your agents look, for you and for every project and worktree.
</p>

<p align="center">
  <a href="apps/website/docs/docs/getting-started.mdx">Get started</a> ·
  <a href="apps/cli/README.md">CLI guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Why Tack

Every coding agent looks for your setup in its own place. Claude Code reads `.claude/skills`,
Codex reads `.agents/skills`, and Cursor reads `.cursor/skills` and `.cursor/commands`. Each
project keeps its own copy, and each worktree keeps another. Docs and scripts end up pasted
wherever they were last needed. You fix one copy, and the others drift. When you try a new agent,
you start again.

Tack keeps one copy of your setup, the one you maintain, and links it everywhere it is needed.

## What Tack manages

| You write | What your agents get                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Skills    | A link in each agent's skills folder, for you across every project or for one project.                                      |
| Commands  | A link in Cursor's commands folder.                                                                                         |
| Context   | One shared place for the rules and notes your agents follow. Tack catalogues it; no agent receives it yet.                  |
| Docs      | A mount at `.tack/docs` in every worktree, a local browser reader and `tack docs search`.                                   |
| Scripts   | `tack script run NAME` in any registered project, with only the secrets the script declares and a run history.              |
| Profiles  | An exact, reviewed set of resources for a project or a remote agent. See [profiles](#profiles-for-teams-and-remote-agents). |

## How it works

- **Your setup stays yours.** It stays in your folders, under your version control. Agents get
  symbolic links, never copies. Tack records each link it creates and removes only those.
- **Every agent, every project, every worktree.** One source reaches Claude Code, Codex and Cursor,
  for you and in each registered project, and Tack links each worktree of a project too.
- **Preview first.** `tack sync` shows the plan. Nothing changes until you add `--apply`.
- **One setup for the whole team.** Keep the setup in one Git repository. Each teammate clones it,
  adds it with `tack source add` and links it into the agent they use.
- **Your agent can run it.** Tack ships a `use-tack` skill that teaches agents its commands. Every
  view ends with the next command to run, and `--json` gives scripts a stable contract.

## Profiles for teams and remote agents

A profile is a file in your source that lists the exact resources a project gets. You review it
like any other change in the repository, and `tack check` validates it.

- **The same set for every teammate.** `tack profile apply` gives a project exactly the profile's
  list. Ordinary picks cannot change that set, and `tack status` and `tack doctor` show it.
- **One file for an agent that runs elsewhere.** `tack profile export` packs the profile's files
  into one `.tar.gz` bundle with checksums. On a fresh machine, in a container or on a CI runner,
  `tack profile apply-bundle` sets up the same links without the original sources and without
  fetching anything.

```sh
tack profile export agent-setup:reviewer reviewer.tar.gz --apply
tack profile apply-bundle reviewer.tar.gz --project app --target-root ~/app --apply
```

Scripts and docs in a bundle need a few more declarations: see
[fixed profile authoring](apps/cli/README.md#fixed-profile-authoring).

## See it

A source with one of each kind. In the project `app`, `tack sync` links the skill into each agent,
links the command into Cursor and mounts the docs:

```text
$ tack source add ~/agent-setup
tack source add · ✓ success

Registered source ~/agent-setup.

  id    9c3ded47-c810-42ff-9872-2ccf405b9745
  docs  handbook

1 skill · 1 command · 1 context · 1 script · 1 docs

$ tack sync --project app
tack sync · project app · ✓ success

Nothing was written. 4 changes planned.

claude → app · 1 to link
  create  .claude/skills/        directory
  create  .claude/skills/review  skill review

codex → app · 1 to link
  create  .agents/skills/        directory
  create  .agents/skills/review  skill review

cursor → app · 2 to link
  create  .cursor/commands/         directory
  create  .cursor/skills/           directory
  create  .cursor/commands/ship.md  command ship
  create  .cursor/skills/review     skill review

Docs · project app
Preview only: nothing was written. 1 docs link to create.

Docs links
  + create  ~/app/.tack/docs/9c3ded47-c810-42ff-9872-   docs handbook · project
            2ccf405b9745/handbook                       app

Next
  tack sync --project app --apply
```

The `source add` output is shortened: its `Next` block is left out.

## Install

```sh
npm install --global @tackup/cli
```

Tack runs on Node 22.12 or later, or on Bun. Then follow [Get started](apps/website/docs/docs/getting-started.mdx)
to register your setup and link it into a project, step by step or with one prompt to your
coding agent.

Not sure what to do next? Run `tack doctor`. It checks your setup and ends with the commands to run.

## Learn more

- [Get started](apps/website/docs/docs/getting-started.mdx): install Tack and link your setup into a
  project.
- [CLI guide](apps/cli/README.md): every command, the adapters, upgrades and the
  [automation contract](apps/cli/README.md#automation-contract).
- [Reader author guide](packages/reader/README.md): configure and customize attached docs.
- [Script API and runner](packages/core/README.md): write a script Tack runs.
- [Glossary](CONTEXT.md): source, resource identity, scope and activation.

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
