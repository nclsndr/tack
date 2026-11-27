# Portable profile content

`profile apply` needs reachable registered sources. A bundle supplies copied content and fresh
recipient-local source registrations; it is separate from `import add`, which copies upstream
skills into an authored source and maintains import provenance.

## Export and check

Preview `tack profile export tools:ci /artifacts/ci.tar.gz`. The report lists direct/required
resources, source keys, exact files, sizes, modes, SHA-256 digests, provenance and setup requirements.
Review known sensitive-path findings, then repeat with `--apply` to write a new artifact. Export
never overwrites an occupied output. Source names do not pin revisions: the bundle freezes current
bytes, including local edits to imported skills, and records their upstream facts as provenance.

`tack profile inspect-bundle /artifacts/ci.tar.gz` reads its manifest, files and setup information.
Run `tack check /artifacts/ci.tar.gz` to validate archive safety, integrity and the projected
profile's actual direct/dependency inventory. Both work without state, original sources or
network. Neither imports supplied modules, starts a reader, runs scripts, fetches content or
installs packages. Checksums establish integrity, not publisher authenticity.

The artifact contains `manifest.json`, the defining profile file, source-separated projections and
only required resource/support content. Skills include their whole folders; commands/context keep
source-relative files/support; docs include whole directories and reader settings/support; scripts
include entrypoints and explicit package/runtime facts. Operator state, UUID authority, journals,
ownership records, execution history, dotenv and credentials are excluded. Known sensitive paths
refuse even when declared as support, including `.git-credentials`. Ordinary authored text is not certified secret-free.

## Declare support before claiming completeness

A script or docs resource needs an explicit `bundle-support` entry in its source's `tack.yaml`. Commands,
context and skills can also declare required support. Every entry names one existing resource and
uses `complete: true`, `files` and non-secret `prerequisites`. Files/directories are source-relative.
No tool discovers closure by executing content.

```yaml
version: 1
name: tools
scripts:
  - name: report
    path: tools/report.ts
    description: Produce a report
profiles:
  - name: ci
    path: profiles/ci.yaml
bundle-support:
  - kind: script
    name: report
    complete: true
    files: [tools/helpers.ts, package.json, bun.lock]
    prerequisites: [Bun runtime, Install the declared package versions explicitly before script run]
```

For an entrypoint with no package dependencies, use `package: none` explicitly instead of claiming
missing package facts. If modules import external packages, include package.json and lock
information and name the package in the setup prerequisites. Materialize workspace/file dependencies
or declare published external prerequisites. No package hook runs automatically. Content portability
does not promise offline script execution.

Docs support must include required reader modules, assets and support outside the selected directory.
Relative Markdown/MDX links, reference-style assets, HTML/JSX asset attributes and static module
imports (including MDX side-effect imports) need included content. Prose, inline code and fenced
examples do not declare executable imports. Any non-literal import/require argument is computed. Missing helpers,
undeclared package facts, computed module paths or incomplete reader support produce
`profile-bundle-incomplete` with a repair. Add the named regular content; do not execute it to infer
closure. Source symlinks require explicit materialization. Scripts remain explicit-run resources,
context stays inspectable, and docs require a project target.

## Apply in a fresh dedicated environment

Provision the bundle separately, then use this sequence with an explicit state directory:

```sh
tack --state-dir /var/lib/tack-ci state init
tack --state-dir /var/lib/tack-ci project add ci --repository-cwd /workspace/repo
tack --state-dir /var/lib/tack-ci adapter enable cursor
tack --state-dir /var/lib/tack-ci profile apply-bundle /artifacts/ci.tar.gz --project ci --target-root /workspace/repo
tack --state-dir /var/lib/tack-ci profile apply-bundle /artifacts/ci.tar.gz --project ci --target-root /workspace/repo --apply
```

No original `source add`, prior ordinary sync or force is needed for this fresh defaults-only target.
Repeat `--target-root` for every root sharing the named project. User application instead needs
`--user --target-home /isolated/home`, matching HOME and an explicit state directory inside that
home. Scratch paths that still share ordinary user intent or redirected adapter parents refuse.
Force never authorizes partial roots, unsafe parents or another context's recovery.

Apply validates the complete boundary before retaining payloads, registering projections or replacing
selection. It retains content under the explicit state directory and creates fresh local identities
mapped from artifact/source keys. Original registrations and bytes remain independent, including
newer same-name originals. Every resource/dependency resolves through the artifact mapping; missing
members never fall back to originals. Qualified `bundle-…` labels distinguish retained projections.
They do not contribute ordinary defaults to other targets; adoption is an explicit copy.

Existing picks, exclusions, docs intent, owned deliveries, recovery records and empty/incomplete
applications require `--force`. Foreign files remain protected conflicts. Intent and payloads remain
after incomplete delivery, even with zero successful links; subsequent sync retries the same fixed
inventory. Reapplying an identical artifact reuses only its verified registrations and content, and
still needs force when intent exists. Different revisions keep distinct retained payloads.

`profile-bundle-identity` means conflicting source keys/mappings, changed retained bytes or foreign
occupied payload paths. Repair the named mapping/path or choose another dedicated context; force
cannot overwrite or rebind it. Retained projections are immutable: save into an authored source
instead of editing them. Status/doctor expose `source-bundle-changed` when retained integrity fails.
Do not remove payloads still referenced by links or recovery.

`profile-bundle-file-access-failed` means a file the command reads or writes cannot be accessed: the
bundle named on the command line, the export output or a retained payload path. The message names
the path and the reason, such as "it does not exist". Correct the path or its permissions and run
the command again.

The initial bundle version is 1, using bounded POSIX ustar regular files/directories in gzip:
8 MiB compressed, 32 MiB expanded, 8 MiB per file, 5,000 entries. Unsafe/absolute/traversing paths,
duplicates, case/Unicode conflicts, unsafe parents, links, special files, unsupported versions and
bad digests refuse before target mutation. `profile-bundle-version` requires a compatible release
or a version-1 export; source, profile, bundle and state versions are independent.
