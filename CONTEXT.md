# Tack

Tack manages source-owned resources for coding agents, project documentation, and trusted local
programs. Resource identity, selection, delivery, and execution are distinct concepts.

## Language

### Sources and identity

**Operator**:
The person who registers sources and projects, makes local choices, and runs Tack operations.
_Avoid_: detected user

**Source**:
A directory that contributes the Tack resources its declaration names. A source can contribute
resources of several kinds. It is the only grouping of resources.
_Avoid_: skill source, code source, installation, skill pack

**Source registration**:
The operator's local record identifying one source at its canonical location. Its identity remains
stable when the operator explicitly relocates the source.
_Avoid_: source declaration, resource identity

**Source declaration**:
A versioned document authored within a source. It describes source content independently of the
operator's local registration. The `tack.yaml` at the top of a source supports versions 1 and 2.
Both carry a source label, maintainers, source dependencies and the resource declarations that say
where each kind of resource lives; version 2 also publishes profiles and bundle support. Source, profile, bundle and local-state
formats are independent. Nothing is a resource unless a declaration covers it. Each `tack.yaml`
marks the edge of one source: below a source's root, a folder that holds `tack.yaml` and no
`SKILL.md` belongs to another source, and declarations never merge or inherit across that edge.
_Avoid_: machine configuration, registration, inherited defaults, area declaration

**Source folder entry**:
A resource declaration whose path is `.`: the folder that holds the `tack.yaml` is a folder of
skills, of commands, or of docs. A `tack.yaml` with one declares that one kind, so content of
another kind beside it is its own source. Context is never declared this way.
_Avoid_: collection, flat source, top entry, kind source

**Resource declaration**:
One entry, under one kind, in a source's `tack.yaml`. It names where resources of that kind
are, and it is the only way a resource enters the catalog.
_Avoid_: kind folder, area, convention, mount, root

**Declared path**:
The source-relative path of a resource declaration. It names a declared folder or one resource, and
it resolves inside the source.
_Avoid_: root (a project worktree), location (a remote import location), target

**Declared folder**:
A folder named by a skills, commands or context declaration. Tack finds that kind's resources
anywhere inside it, narrowed by the declaration's patterns, except inside a folder of another
source.
_Avoid_: kind folder, root, area, scope

**Include and exclude patterns**:
Glob patterns of a declaration with a declared folder, matched against paths relative to that
folder. They narrow which resources the declaration contributes. A folder whose path matches an
exclude pattern is not entered, so an archive folder is excluded with `**/_*/**`.
_Avoid_: filters, ignore list, reader content patterns (those choose documents inside one docs resource)

**Group folder**:
A folder inside a declared folder that is not a resource. It organizes resources and never changes a
resource's name or identity.
_Avoid_: namespace, category, nested skill, scope

**Source label**:
The short name by which operators and other sources refer to a source. It is the `name` in the
source's own declaration, which every `tack.yaml` must carry. It never comes from the folder, so
it is the same on every machine. It is never stored in state, picks, docs mount paths, reader routes
or history.
_Avoid_: source ID, registration ID

**Maintainers**:
A descriptive list of contacts supplied by a source's authors. Tack
shows it. It never affects identity, selection, delivery, dependency resolution or editing.
_Avoid_: editors, reviewers, access list

**Source dependency**:
A source's declaration that its resources may depend on resources from another named source.
_Avoid_: package dependency, source import

**Provenance**:
The source from which a resource originates, and how that source arrived: `builtin` when Tack
supplies it, `registered` when the operator registered it, and `bundle` when a profile bundle
provided it. `catalog` reports it as `origin`. Provenance is independent of the resource's
selection namespace.
_Avoid_: activation

**Built-in source**:
A declared source shipped and versioned with Tack, available without operator registration.
_Avoid_: mandatory source, user namespace

**Built-in skill**:
A skill contributed by a built-in source, with the same selection rules as other skills. The
built-in source carries `use-tack`, for operating Tack, `manage-tack-sources`, for creating and
maintaining a source, `author-tack-profiles`, for authoring and checking profiles,
`write-reader-figures`, for authoring doc figures, and `prepare-tack-checkout`, for linking a
repository's skills at the start of work in a new clone or worktree. Built-in provenance does not require an agent to
load its instructions. A release-owned skill is a built-in skill everywhere, in code, codes and
text, and never a global skill, even though `sync --user` links it at user level like one.
_Avoid_: mandatory skill, always-loaded skill, global skill

**Kind**:
The category of a resource: skill, command, context, script, or docs. Each kind has its own
identity, selection, and delivery rules.
_Avoid_: source

**Resource**:
One source contribution of a supported kind. Its content remains in the source when Tack makes
it available elsewhere.
_Avoid_: copied content, installed package

**Resource identity**:
The source registration, the kind, and the name of one resource. It applies to skills, commands,
context items, script entrypoints and docs resources alike. The same kind and name in two sources
are two identities. Code and JSON carry it as a resource address.
_Avoid_: qualified name

**Resource address**:
The typed value of one resource identity that code and JSON carry: `sourceRegistrationId`, `kind`
and `name`. A choice stores one as its `address`, and selection and dependency results carry it.
It never holds a source label, so no address exists without its source.
_Avoid_: reference (the text an operator types), qualified name, path

**Resource reference**:
The text an operator or agent types to name one resource: `name`, or `source:name` where the source
part is a source label or a source registration ID. A reference resolves to exactly one resource
address or fails and lists the candidates.
_Avoid_: qualified name, path

**Name clash**:
Two healthy resources of one kind with the same name in different sources. A collision is the
separate delivery case where two selected resources need one destination name.
_Avoid_: duplicate, collision

**Catalog**:
The validated view of resources from registered and built-in sources, including quarantine
reasons and source health.
_Avoid_: installed resources, selected resources, directory listing

**Quarantined resource**:
A resource excluded from selection, attachment, or execution because its declaration, contents,
metadata, or identity is invalid or ambiguous.
_Avoid_: unselected resource, ignored resource

**Import**:
An operator-requested copy of one skill folder from a remote location into a declared skills folder
of a source the operator owns, with an import record. After the copy the folder is the operator's
content: they edit it, and Tack delivers it like any skill in that source.
_Avoid_: install, clone, download, vendor, snapshot

**Import provider**:
A named kind of remote location that Tack can import from, such as `github`. It decides how its
locations are written, recognized, compared and fetched, and its name is the prefix of every
canonical location it owns. Each provider is one adapter in one registry.
_Avoid_: host, forge, backend, source (a source is a registered directory), transport (the `https`
or `ssh` the operator typed)

**Provider prefix**:
The `<name>:` at the start of a location, such as `github:`. An operator types it for shorthand
(`github:org/repo`); a URL names its host instead. Bare `org/repo` is refused.
_Avoid_: scheme (reserved for URL schemes), namespace

**Destination source**:
The registered source an import writes into, chosen with `--into`. It is never the built-in source.
_Avoid_: target, store, import source

**Imported skill**:
A skill folder in a destination source that has an import record.
_Avoid_: remote skill, vendored skill, imported source

**Imports section**:
The top-level `imports` key of a destination source's `tack.yaml`, which holds its import records.
Tack owns every byte of it and edits it as text; the rest of the file stays the author's.
_Avoid_: lockfile, manifest, sidecar

**Import record**:
The entry that ties one imported skill folder to its location (`<provider>:<text>`), ref request, resolved
revision, upstream folder and tree ID, and the digest and executable bit of each file as Tack wrote
it.
_Avoid_: lock entry, state record

**Local change**:
Any difference between an imported skill folder now and the files its import record lists: a file
added, removed, or changed in bytes or executable bit.
_Avoid_: drift (used for links), modification, dirty (used for git)

### Namespaces and selection

**Namespace**:
The scope that owns an independent set of resource choices: one registered project or the user.
_Avoid_: source, root

**Project**:
A named namespace with one registered Git anchor and one or more registered roots. Its choices
apply across those roots.
_Avoid_: repository path, root, checkout

**Root**:
One registered Git worktree directory belonging to a project. It is a concrete destination and
can be the target of one script run.
_Avoid_: project, source

**Selector**:
The scope requested by a command: bare, `--project NAME`, `--user`, or `--all`. A target is one
resolved destination within that scope.
_Avoid_: target, namespace

**Bare selector**:
No selector flag. The working directory or `--cwd` chooses the project.
_Avoid_: default scope, implicit all

**Containing root**:
The deepest active registered root containing the canonical working directory. Ordinary target
selection uses path containment; `project refresh` also checks the worktree's Git directory.
_Avoid_: current root, authorizing root

**Containing project**:
The project owning the containing root, including all its active roots.
_Avoid_: current repository, current root

**Machine-wide scope**:
Every registered project, the user target, and their pending removals. `--all` selects it for
commands that take a selector; `doctor` takes none and is always machine-wide.
_Avoid_: global, bare scope

**Out-of-scope pending removal**:
A retained cleanup obligation outside the requested selector. `status` and `state clean --pending` report its
count and owners without changing their success classification.
_Avoid_: hidden removal

**User-level target**:
The user namespace and its destination, separate from every project. It also provides the home
context for a user-level script run.
_Avoid_: global project, all projects

**Skill**:
A named directory of agent instructions identified by its skill document. Its directory name and
declared name agree. The directory is a leaf: files below it, including another skill document,
are its content.
_Avoid_: command, plugin, arbitrary Markdown file

**Command**:
An agent-facing Markdown instruction resource whose identity uses its filename without the
extension. Its containing folders do not qualify its name.
_Avoid_: Tack CLI command, shell command, script entrypoint

**Context item**:
An uninterpreted file found by a context declaration, named by its path relative to the declared
folder, including extension.
It is selected only by an explicit positive choice and has no agent delivery.
_Avoid_: docs resource, attachment, automatically loaded context

**Activation**:
A skill or command's default selection policy for one namespace. Project and user activation are
independent, and explicit choices can override them.
_Avoid_: loading, invocation, installed state

**Project compatibility**:
A skill or command's declared restriction on default selection in project namespaces. An explicit
positive choice can force selection outside that restriction.
_Avoid_: activation, agent compatibility, run-target applicability

**Choice**:
A persisted include or exclude decision for one exact resource in one namespace. Every choice
records the resource's source registration, kind and name.
_Avoid_: activation, source setting, docs attachment

**Pick**:
The CLI word for a choice. `tack pick` lists the choices of a namespace, `pick include` and
`pick exclude` store one at once, and `pick remove` deletes one. A pick and a choice are the same
record.
_Avoid_: install, pin, selection

**Resource dependency**:
An edge from a skill or command to another skill or command, naming a kind and a name. It resolves
inside the requester's source or a source the requester's source declares. Required dependencies
extend selection; optional dependencies participate only when requested for the invocation.
_Avoid_: package dependency, name-only dependency, capability requirement

**Selection**:
The desired resource set for one namespace after activation, compatibility, choices, and requested
dependency closure have been resolved. Script entrypoints are run by reference rather than selected.
_Avoid_: delivery, instruction loading, invocation

**Global skill**:
A skill from a source other than the built-in one that the user namespace selects, by its user
activation or an explicit choice, and that Tack links at user level for discovery across projects.
Global availability does not require the agent to load it in every session. A release-owned skill
is a built-in skill, never a global skill.
_Avoid_: built-in skill, always-loaded skill, global (as a noun), global activation (it is user
activation)

**Project skill**:
A skill selected in a registered project's namespace and delivered for discovery in its roots.
_Avoid_: local-only skill

**Delivery**:
The presence of a selected or attached resource at its supported destination. Selection or
attachment alone does not imply delivery, and delivery does not imply agent instruction loading.
_Avoid_: selection, activation, instruction loading

**Instruction loading**:
An agent's act of bringing a skill or command's instructions into its working context. Discovery
and delivery make instructions available without guaranteeing this act.
_Avoid_: installation, activation, script execution

**Invocation**:
A request to use a skill or command, or to execute a Tack script. Availability and selection alone
do not constitute an invocation.
_Avoid_: activation, delivery

### Agent delivery and maintenance

**Agent adapter**:
Tack's known mapping between resource kinds and one coding agent's preferred destinations.
Enabling an adapter is an operator decision, independent of installed-product detection.
_Avoid_: detected agent, agent installation

**Adapter capability**:
A delivery operation supported by an agent adapter, such as skill links or command links.
_Avoid_: script capability, capability requirement

**Managed link**:
A relative symbolic link with retained evidence that Tack created it for an exact resource and
destination. Removal requires agreement between that evidence and the observed target.
_Avoid_: copied resource, arbitrary symlink, ownership of source content

**Reconciliation unit**:
One project root or user-level target paired with one enabled agent. Each unit is planned and
applied independently.
_Avoid_: whole run, project, script run target

**Source removal**:
The preview-apply operation that retires one source registration. It removes every managed link and
docs mount of the source's resources, then the registration, its picks in every namespace, its docs
attachments and the fixed profile applications it publishes. It never touches the source directory.
_Avoid_: unregister, delete source

**Project removal**:
The preview-apply operation that retires one whole project. It removes every managed link and docs
mount in the project's roots, then the project with its picks, docs settings and fixed profile
application. A link it cannot remove safely keeps the project in removal until that cleanup settles.
It never touches a worktree.
_Avoid_: unregister, root removal (one worktree leaving through refresh)

**Pending removal**:
A retained cleanup obligation for a managed link, of either delivery kind, that Tack could not safely
remove. It preserves ownership evidence until removal or confirmed absence settles the obligation.
_Avoid_: forgotten link, discarded evidence

**State document**:
The file that holds operator intent, ownership evidence and the recovery journal for one state directory.
_Avoid_: database, config, persisted model

**State format**:
The number that names the state document layout. It is independent of the Tack release version. It
is written under the envelope key `format`, which is the document's first field. Tack reads and
writes one format, 1.
_Avoid_: schema version, state version

**State writer lock**:
The `state.lock` file in a state directory. One Tack process holds it while it writes the state
document and records its process ID there. Another writer fails with `state-busy` and changes
nothing.
_Avoid_: database lock, mutex, lockfile (the imports section)

**Operator intent**:
The selected adapters, sources, projects, roots, choices and docs settings requested by the operator.
_Avoid_: config, desired state

**Ownership evidence**:
The exact destination, source, adapter and target facts retained when Tack creates a link. These
facts authorize removal even after a source or project is gone.
_Avoid_: link list, installed skills

**Link record**:
The one record for a physical managed-link destination, of either delivery kind, with its stored destination, ownership evidence and any pending removal.
_Avoid_: managed-link entry, membership

**Delivery kind**:
What a link delivers: an agent resource through an adapter, or a docs mount. Both kinds share one way to apply, recover and prove a link. The kind decides only the parent policy (agent links resolve through directory aliases; a docs mount needs ordinary, unredirected parents), the ownership proof and where the destination comes from.
_Avoid_: link type, engine, adapter

**Recovery journal**:
The prepared actions of one apply, saved in one checkpoint before its first filesystem change and settled in one checkpoint after its last, so the number of state writes does not grow with the number of links. A later run settles any entry left behind by observing its destination; an entry whose parent its delivery kind refuses stays prepared and blocks only its own destination.
_Avoid_: log, transaction, write-ahead log

### Commands and outcomes

**Plan and apply**:
The mutation mode of a command that changes links or state. Without `--apply` it previews its plan
and writes nothing; with `--apply` it applies the plan it made. `--help` names each command's
mutation mode: `read-only`, `immediate` (persists at once, such as `pick include`), `preview-apply`,
`execute` (runs a script) or `conditional`; the text help map shortens them to `read`, `now`,
`plan`, `run` and `conditional`.
_Avoid_: dry run, confirmation, force

**Diagnostic**:
One structured finding a command reports beside its result: a stable kebab-case `code`, a message,
a severity (`info`, `warning` or `error`) and optional details. The code, not the message, is the
contract automation relies on.
_Avoid_: error (a diagnostic can be a warning), log line

**Partial outcome**:
A command that ran but left something needing attention: healthy parts still complete, the outcome's
status and classification are `partial`, each cause is a diagnostic, and the exit code is 1. It is
not a Tack failure. The classification names the cause class of any outcome and decides its exit
code.
_Avoid_: failure, success with warnings

**Doctor check**:
One read-only observation that `doctor` reports: a stable `id`, an outcome (`ok`, `warning`,
`failed` or `skipped`), a message and, for a problem, the exact next command. Checks cover the whole
machine; a `failed` check makes `doctor` exit 1, a `warning` does not.
_Avoid_: test, repair, lint

**Explorer**:
The interactive terminal window that `tack explore` opens for an operator; agents and
non-interactive callers are refused. It shows the catalog and edits one destination: the user or a
project selection (picks and docs attachments, applied with a sync), a profile file, or a selection
copy saved as a profile. It opens the containing project, else the destination chooser, whose
`Browse only` entry edits nothing. Staged changes are written only after the operator confirms
their review. `tack catalog` is its read-only, scriptable counterpart.
_Avoid_: browser, picker

### Tack releases

**Tack package**:
The npm package `@tackup/cli`, which installs the `tack` executable for Node or Bun. The package
manager that installed it owns its upgrades; Tack never upgrades itself.
_Avoid_: binary, installation, release location

**Tack executable**:
The program called as `tack`: the installed package's bin.
_Avoid_: Tack command, global Tack, CLI binary

**Install kind**:
How the running Tack was installed: `npm`, `bun` or `source` (a checkout). It decides the command
`tack upgrade` names.
_Avoid_: channel, distribution

**Built-in copy**:
One version's built-in source, copied out of the package into `~/.tack/builtins/<version>/`
(`TACK_BUILTINS_DIR`). Managed links to built-in skills resolve there, so clearing the package
manager's folder never breaks them. A sync removes copies that nothing needs.
_Avoid_: built-in location, release directory

**Release stamp**:
The version plus build metadata for its commit and, when built ahead of `origin/main`, its ahead
count, for example `0.1.0+gfec4c8e.ahead.2`.
_Avoid_: build number, tag

**Release gate**:
The checks a built package, and the compiled build the evals container runs, must pass in CI.
_Avoid_: CI, smoke test

**Source run**:
Running Tack from a checkout through Bun, for development. It uses `bun run --cwd <checkout> tack`
and isolated state when testing Tack itself; `bun run install:local` installs the checkout as the
global `tack`.
_Avoid_: dev mode, local binary

### Documentation

**Docs resource**:
An explicitly declared, named document directory inside a source. It is attached to projects as a
whole directory and remains distinct from individual context items.
_Avoid_: context item, implicit project docs folder, merged corpus

**Attachment**:
A project's persisted association with one exact docs resource. It applies to the project's roots
without selecting a revision or transferring ownership of the documents.
_Avoid_: resource choice, copied documentation, source registration

**Docs mount**:
The managed link, of the docs delivery kind, that makes one attached docs resource readable in
every active root of a project, at `SOURCE_ID/NAME` under the project's docs destination
(`.tack/docs` unless `docs configure --destination` changes it). `sync` plans and applies it with agent links; `--no-docs` and `--no-adapters` narrow
that.
_Avoid_: docs copy, attachment (the persisted intent)

**Default writing resource**:
The attached docs resource a project selects as its default destination for authored documents.
_Avoid_: reader corpus, implicit project folder

**Corpus**:
The saved documents selected from a project's attached docs resources for reading and search.
Resource issues can leave a corpus explicitly incomplete.
_Avoid_: entire source tree, current working directory, copied documentation

**Reader cache**:
The reader's build cache for one project root, at `cache/reader/<project>-<root hash>` in the state
directory. One `docs serve` session holds it at a time and keeps its compiled pages for the next
launch; a second session on the same root starts from a private, cold cache instead.
_Avoid_: theme (the files one session generates there and removes when it stops), project cache

### Script execution

**Tack script**:
A trusted local async function, defined with `defineScript` from `@tackup/cli`, with declared
arguments and secrets. Tack provides the API at run time, owns its execution and reports its outcome.
_Avoid_: arbitrary TypeScript file, shell command, agent command, Effect program

**Script entrypoint**:
An executable module declared in a source's `tack.yaml` with a name, a path and a
description. Its identity uses the source, the script kind, and the declared name.
_Avoid_: discovered runnable file, package export, every file in a source

**Script API**:
The `defineScript` options, the run context and the outcome codes a script author relies on. The
running Tack provides it, so a script always matches the Tack that runs it.
_Avoid_: installed script package, Effect contract

**Capability requirement**:
A secret name or Tack-provided service that a script declares it needs for execution. It is
separate from the delivery operations supported by an agent adapter.
_Avoid_: ambient dependency, hidden service, adapter capability

**Expected failure**:
A domain failure intentionally exposed by a Tack script through its declared expected-failure
boundary. Declaring no expected failure does not make required services operationally infallible.
_Avoid_: capability failure, defect, interruption, cleanup failure

**Capability failure**:
An operational failure from a Tack-provided service. It is distinct from the script author's domain
failures and does not pass through the expected-failure boundary.
_Avoid_: expected failure, non-zero shell exit, defect

**Direct test run**:
An author's in-process execution of a Tack script with explicit fake capabilities. It uses the
script's boundary and outcome rules without an operator history record.
_Avoid_: operator run, live-service invocation

**Operator run**:
A supervised attempt to execute one addressed Tack script against exactly one run target,
with local history and a public outcome.
_Avoid_: direct test run, reconciliation unit, multi-root run

**Run target**:
Exactly one registered project root or the user-level target chosen for an operator run. It
supplies execution context rather than selecting the source or granting access control.
_Avoid_: project as a whole, machine-wide scope, source directory

**Run outcome**:
The structured result of validation, execution, and finalization, retaining success or the
specific failure class.
_Avoid_: exit code, thrown exception, success value alone

**Finalization**:
The cleanup of resources owned by a Tack script run. Its completion, failure, or incompleteness
is reported independently of the program's primary result.
_Avoid_: successful return, process exit, result encoding

**Run history**:
Local evidence of recognized operator run attempts and their recorded outcomes. An incomplete
record identifies an attempt whose terminal state was not durably recorded.
_Avoid_: catalog, general application logs, proof that an interrupted run completed

### Profiles

**Profile**:
A separately versioned, fixed list of resources to include, published by a version-2 source through
`profiles: [{ name, path }]`. It references source-owned resources and adds no resource kind. A bare
member name stays within the publishing source, an external member keeps a portable source
qualifier, and required closure follows resource dependency rules. Authoring or checking a profile
changes no daily selection or delivery. `author-tack-profiles` teaches the file and the checker.
_Avoid_: preset, pack, resource kind

**Fixed profile application**:
Local, exact membership intent for one completely authorized project or isolated user target. It
keeps its direct and required identities across incomplete delivery. Sync does not follow later
defaults, manifest edits or a changed closure, and ordinary daily selection stays independent of
it. Saving and adoption are explicit, one-time membership copies.
_Avoid_: subscription, profile sync, choice

**Profile bundle**:
An independently versioned content snapshot with one projection per source, integrity facts for the
current bytes and non-secret setup requirements. Each source it provides becomes a fresh
recipient-local registration backed by retained, verified content, distinct from the original
source and from built-in sources; its resources have `bundle` provenance. Explicit artifact and
source-key bindings resolve members and dependencies; a matching display name or matching bytes
never authorize reuse of an original registration. Its defaults do not enter other contexts
automatically. A bundle carries no sender state or ownership authority and runs no supplied code or
package setup.
_Avoid_: export, archive, backup
