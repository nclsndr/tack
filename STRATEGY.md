# Tack Strategy

## Vision

<!-- vision: author-approved 2026-11-22 -->

`tack` exists so that the resources and tools that make coding agents useful are written once and reach every agent that needs them.
It is a synchronization engine: it keeps the resources declared in sources in step with the places each agent reads them, for the user and for every project and worktree.
Resources are what agents read, today skills, commands and context.
Tools are what agents use, today docs to read and search, and scripts to run.
The list of kinds follows how agents work: a kind joins when agents need it, and a kind leaves when agents stop using it.
Tack delivers both the same way to every agent it supports, with no agent preferred.
It scales in two directions.
Across machines, because a source is a plain folder, usually under version control, and a profile bundle carries a fixed set to a fresh machine, container or CI runner.
Across people, because a team keeps one source repository, and each teammate links it into the agent they use.
It serves the operator, and the agent that runs Tack on the operator's behalf.
It owns exactly one thing: keeping declared, source-owned resources delivered where agents read them, with proof of every write it made.

### The source stays the operator's

Content stays in its source, a folder the operator owns and usually versions.
Agents get relative symbolic links, never copies, so one edit reaches every agent.
When a link cannot work on a host, Tack looks for another way to link, and otherwise reports the failure with a severity that matches its impact; it never falls back to a copy.
Where an agent reads a resource only from a shared configuration file, such as MCP server definitions, Tack writes only the entries it records owning and removes only those.
Tack removes only what it recorded writing, and only when that record agrees with what it finds.
Tack never edits, moves or deletes a source directory or a worktree.
Tack does not write into project files it did not create, such as AGENTS.md or .gitignore: `tack guide` gives the text, and the operator or their agent writes it.
A copy happens only when the operator asks for it by name, as with an import or a profile bundle, and the copy then belongs to the operator.

### Agents are the first operators

Tack is built to be run by agents first, and people read the same output, because a person rarely needs more than an agent does.
An agent completes a Tack task in as few tool calls and tokens as possible.
One command takes a whole intent at once, such as a complete source configuration, rather than many flags over many calls.
Every view ends with the exact next command, so the agent never has to look for it.
Output is short and clear, uses the operator's words, and stays stable; shorter output is welcome when it reads clearer to both.
The built-in skills and `tack guide` teach agents to run Tack, and they always match the CLI of the same release.
Advice that depends on a project's content, such as which skills fit or how an agent reads a format, lives in built-in skills and guides, not in Tack's logic.
The explorer is for people, and every change it makes is also a plain command.

### Nothing is implicit

A resource exists only when a source's `tack.yaml` declares it.
Tack does not infer resources from folder names, agent conventions or unregistered folders.
Selection comes from activation and explicit picks, never from detection or guessing.
When Tack skips or ignores something, it says so with a diagnostic, and a silent skip is a bug.

### Every command names its mode

Each command has one mutation mode, and its help names it: read-only, immediate, preview-apply, execute or conditional.
A command that changes links or delivery shows its plan and writes nothing until `--apply`.
A command that writes at once, such as `init` or `pick include`, reports everything it wrote.
Tack can enable an agent it finds installed, as `init` does, and it always names that agent in the output.
A change that cannot finish safely leaves a pending removal and a recovery record, never a guess.

### Every agent, honestly

Each adapter writes only to its own agent's folders and states plainly which kinds its agent receives and which it does not.
When an agent cannot read a kind in the form the source holds, Tack reports the gap and does not translate the content.
Delivery makes instructions available; whether and when an agent loads them is the agent's decision.
A team can fix a project to one reviewed set with a profile, and Tack shows each teammate what that profile refuses.
A profile governs its project only and never changes the operator's user-level setup.

### Scope

Tack is not a package manager, a registry or a skill marketplace.
Import is a convenience that copies one skill once into a source the operator owns; Tack does not track or merge later upstream changes, and import grows only when users hit a proven problem.
Tack is not a coding agent, and it does not decide what an agent loads into its context.
It is not a secrets manager: it holds no secret of its own and passes declared secrets from a store the operator chose, today a `.env` file, later other stores such as 1Password through adapters.
A script or an MCP server definition receives only the secrets it declares, and a secret lands on disk only where its delivery design accounts for it.
It is not a sync service: state stays on one machine, with no whole-machine configuration file; an export and import of state for backup and portability fits, while synchronization does not.
It is not an installer: the package manager that installed Tack upgrades it.
Scripts are trusted local programs, and Tack adds no new script runtime and runs no code that a bundle supplies, because every runtime is a lasting cost to keep working everywhere.
This repository holds itself to the same model: it declares its own skills in `tack.yaml` and delivers them with Tack.

A change aligns when it brings content the operator already owns to one more agent, project, machine or person.
A change also aligns when it cuts the tool calls or tokens an agent spends, or makes a skipped, partial or refused outcome visible.
A change should be resisted when it copies or rewrites content the operator did not ask to copy, or when Tack writes into a project file it did not create.
A change should also be resisted when Tack guesses a resource or a selection, or when it adds a runtime, a registry or a sync service to maintain.
