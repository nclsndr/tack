---
name: manage-tack-sources
description: Author Tack sources, folders of skills, commands, context, scripts and docs. Use before editing any file inside a source, to check its maintainers first, and to create or register a source, declare resources in tack.yaml, set dependencies, resolve name clashes or fix catalog issues.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: default
---

# Manage Tack sources

For fixed resource manifests, use `author-tack-profiles`. Its version-2 `profiles` publication references resources without creating a sixth resource kind.
Version 2 also accepts `bundle-support` for explicit content closure and non-secret prerequisites;
read `author-tack-profiles` before exporting scripts, docs or resources with support content.

A source is a directory that holds resources. It is the only grouping Tack has: a resource is
identified by its source, its kind and its name. Use this skill to create, change or register a
source. The `use-tack` skill operates Tack: pick, sync, upgrade, run scripts, search docs, and it owns
the output and preview-before-`--apply` rules that apply here. Read the text views of `source` and
`catalog`; their JSON has no stable schema. Tack's state files are Tack's to write.

## Orient before editing

```sh
tack source     # each source: label, maintainers, path, health, declarations
tack catalog    # resources, and issues that need a fix
tack catalog --details   # also the declared path that found each resource
```

`source` shows a `label` and `maintainers` for every registered source, and for a healthy one its
`declarations`: each entry's kind, `path`, `include` and `exclude` patterns, the number of
`resources` it contributes and its `problems`, each with a reason code. A declaration that finds
nothing shows `0` and is valid. `catalog` lists issues with the exact fix in each message, and with
`--details` each resource carries `declaredPath`, the entry that found it. Read both before changing
anything. `catalog` exits 1 while any issue remains, and `source` stays healthy when a declaration
has problems: read `issues` and every declaration's `problems` before you report success.

## Before changing a source

Read `maintainers` and follow the source's contribution instructions. `maintainers` is descriptive
contact information, not an edit permission or a resource grouping. Work within the operator's
requested scope, using the source's normal review process where applicable.

## Declare resources in `tack.yaml`

Tack reads resources only from the `tack.yaml` at the top of the source. A folder is never read because of its
name: a folder called `skills/` means nothing until a declaration names it. A folder of skill
folders, `.md` commands or docs alone is a **collection**: `version: 1` and `kind: skills`,
`kind: commands` or `kind: docs` ([collections](references/tack-yaml.md#collections)). Otherwise use
the list form below. Each `tack.yaml` is the edge of its source: configs never merge, and one that
another source's declaration reaches is an error.

```yaml
version: 1
name: quality-tools
skills:
  - path: skills
    exclude: ["**/_*/**"]
docs:
  - name: handbook
    path: knowledge
```

For a complete source with several skill paths, patterns, scripts, docs, `depends-on`, resource
dependencies and name clashes, follow [the worked example](references/worked-source.md).

Version 1 supports ordinary resources; version 2 adds `profiles` and `bundle-support` in the same
source declaration. Profile files and bundles have independent versions. Every key but `version` is
optional, so a source may declare only what it holds, such as `docs` alone.
Each resource key is a list and may be empty: `skills: []`. A kind with no entries has no
resources, whatever folders exist, so name every folder that holds resources. Group folders, the
folders between a declared folder and a resource, organize a source and never change a name.

- `name` is the label operators and other sources write, as in `quality-tools:review`: up to 64
  lowercase letters, digits and single hyphens. Without it the label is the directory name when
  that is a valid label, which is local to one machine, so declare it on any source others depend
  on. `tack` and generated `bundle-` labels are reserved, a registration-ID-shaped value is rejected, and two sources with one
  label cannot qualify a reference until one changes. Picks store IDs, never labels.
- `maintainers` lists descriptive contacts. Tack shows it and never interprets it.
- `depends-on` lists labels of other sources.
- `skills`, `commands` and `context` entries have a `path` to a folder, or to one resource, and
  optional `include` and `exclude` globs that need a folder. `scripts` entries have `name`, `path`
  to one `.ts` file and a non-empty `description`. `docs` entries have `name`, `path` to a folder
  and an optional `reader`. Scripts and docs take no patterns.

A fault in the file makes the whole source unhealthy: `declaration-missing`,
`declaration-malformed` (broken YAML), `declaration-version-unsupported`, and
`declaration-schema-invalid` for an unknown top-level key or a bad `name`, `maintainers` or
`depends-on`. A bad entry inside a resource key is quarantined alone; the rest keeps working.

Read [references/tack-yaml.md](references/tack-yaml.md) before writing an entry: paths, overlap,
patterns, the leaf rule, scripts, docs, and the `imports` section Tack writes: never edit it.

| Kind    | Name                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| skill   | Its folder name, which must match `name` in `SKILL.md`; the file also needs a `description`.   |
| command | File name without `.md`.                                                                       |
| context | Path inside the declared folder, with its extension, such as `notes.md`. One file: its name.   |
| script  | The declared `name`. Write its module as [references/scripts.md](references/scripts.md) shows. |

Skill, command and script names use lowercase letters, digits and single hyphens. Two resources of
one kind and name in one source are both quarantined, whichever declarations found them.

## Resource metadata and dependencies

Skills and commands may carry Tack metadata in the `metadata.tack` YAML string of their
frontmatter: `activation`, `user-activation`, `projects` and `dependencies`. Dependencies are declared per resource, in `metadata.tack.dependencies`; `depends-on` in the
source's `tack.yaml` is the source-level allow list that lets a resource reach another source. Read [references/metadata.md](references/metadata.md) before writing either: it has
the keys, the defaults and the five rules that resolve a dependency. Context items carry no
metadata.

## Create and register a source

1. Look inside the folder, then ask the person what each folder holds (skills, commands, context,
   docs, scripts) and which ones Tack should serve. `PATH/SKILL.md` makes PATH one skill: offer its
   parent as a skills collection, or `tack import add` for a remote repository.
2. Without `tack.yaml`: skill folders at the top of PATH take `--skills .`, which writes a skills
   collection, and each other folder of docs or commands there becomes its own source, such as
   `tack source add PATH/handbook --docs .`. Otherwise give one repeatable flag per folder, each a
   path inside the source: `--skills`, `--commands`, `--context` or `--docs`. The preview shows the
   `tack.yaml` and each entry's resource names, count and problems. Show every preview, ask once,
   then rerun each with `--apply` ([declaration creation](references/tack-yaml.md#declaration-creation)).
3. Edit `tack.yaml` by hand only for what flags cannot say: patterns, `scripts`, `depends-on`, a
   docs name other than its folder's. Run `tack check /absolute/path` with any companion source
   folders until clean: it reads no state and runs no authored code. Errors exit 1.
4. With an existing `tack.yaml`, `tack source add /absolute/path` registers at once; run `tack init`
   first when Tack has no state. It reports resource issues with counts and a `tack check` hint. A
   kind flag on such a source fails and writes nothing.
5. Run `tack catalog --details` to verify registration; fix every issue and repeat. `doctor` and
   `status` show health. Deliver the resources with `use-tack`: `tack sync --all`, then `--apply`.

## Add another folder of resources

To hold skills in a second folder, such as `vendor/skills`, of a source:

1. Load this skill and check `maintainers` before editing, as above.
2. Add `- path: vendor/skills` under `skills` in the source's top-level `tack.yaml`, or the entry of the kind it
   holds. Declare the folder, never one inside or around another declared folder: both are
   refused, unless the outer entry excludes the inner one (`exclude: ["vendor/**"]`).
3. Add `exclude` patterns only for what must stay out, such as archives: `exclude: ["**/_*/**"]`.
4. Run `tack catalog` and `tack source`. Read every issue before anything else. Two
   skills with one name in two declared folders are both quarantined: rename or delete one. Report
   them to the operator, and suggest `sync` only when the catalog is clean.

A moved source keeps its registration: `tack source relocate REGISTRATION_ID /new/path`. A retired
one leaves with `tack source remove SOURCE`, which previews first and never touches its files.

Registering, relocating or removing a source happens when the operator asks, and so do `sync` and `pick`:
delivery belongs to `use-tack`. Tack's own built-in source stays as shipped.

## Resolve name clashes

The same kind and name in different sources gives two healthy resources. A bare reference fails
when it cannot choose one. Qualify it as `source:name` with the source label:

```sh
tack pick include base-skills:lint --project PROJECT
tack pick exclude audit-tools:lint --project PROJECT
```

Within one source, duplicate names of the same kind quarantine both candidates. Rename one skill's
folder and matching frontmatter `name`, or exclude it from its declaration. Group folder names
never qualify a resource. See [the worked example](references/worked-source.md#resolve-name-clashes)
for skill, dependency and docs clashes.

If two sources provide a default-activated skill with one name, neither is delivered until the
operator includes one (`pick include SOURCE:NAME`, which wins over the default twin) or excludes the
other.

## Fix catalog issues

| Issue                                                                                            | Fix                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declaration-resources-undeclared`                                                               | The source has no resource key and a folder named for a resource kind. Add the entries its message names, or an empty list.                                                                                                         |
| `declaration-entry-invalid`                                                                      | The entry does not decode: an unknown key, a wrong type, a missing `path`, or patterns on one skill, command or file. Other entries still load.                                                                                     |
| `declaration-path-invalid`                                                                       | The `path` is empty, absolute, has `.`, `..`, an empty segment or a backslash, or names the source's own `tack.yaml`.                                                                                                               |
| `declaration-path-outside-source`                                                                | The path resolves outside the source, or is the source folder itself. Point it inside, or move the content into the source.                                                                                                         |
| `declaration-path-missing`                                                                       | Nothing exists at the path. Create it, fix the spelling, or delete the entry.                                                                                                                                                       |
| `declaration-path-wrong-type`                                                                    | The path has the wrong type: a folder for `skills` and `docs`, a folder or file for `context`, a folder or `.md` file for `commands`, a `.ts` file for `scripts`.                                                                   |
| `declaration-path-overlap`                                                                       | Two skills, commands, context or scripts entries, or a profile publication and one of them, are equal or nested; every one is refused. Add the `exclude` the message names to the outer folder entry, or keep one. Docs are exempt. |
| `declaration-reaches-source`                                                                     | The path is or lies inside a folder with its own `tack.yaml`, or a walk met one and skipped it. Declare those resources there, add `exclude: ["FOLDER/**"]`, or delete the nested `tack.yaml`.                                      |
| `source-is-one-skill`, `declaration-inside-source`                                               | A skills collection holds `SKILL.md`: register its parent. `source add` refused a `tack.yaml` another source reaches: exclude the folder there first.                                                                               |
| `declaration-invalid`                                                                            | A `docs` key that is not a list, or a docs entry with an unknown key or a bad `name`. Fix it as the message says.                                                                                                                   |
| `resource-boundary-violation`                                                                    | A file or link inside a declared folder resolves outside it. Declare the real path, or remove the link.                                                                                                                             |
| `skill-name-mismatch`, `skill-frontmatter-*`, `skill-metadata-*`, `command-*`                    | Fix the frontmatter the message names. The skill folder name must equal `name`.                                                                                                                                                     |
| `source-declares-no-resources`, `collection-folders-skipped`: warnings                           | Empty but healthy: add a resource key, `docs`, or an empty list. Skipped: the collection skips the `commands` and group folders named; use the list form, or make each a source. No exit code changes.                              |
| Dependency source undeclared or ambiguous                                                        | Add the label to `depends-on`, or add `source: LABEL` to the edge.                                                                                                                                                                  |
| Declared source not registered, or unhealthy                                                     | `tack source add` for it, or remove the label from `depends-on`. An unhealthy one: `tack check` the path the blocker names.                                                                                                         |
| `skill-address-duplicate` or `resource-address-duplicate`: one kind and name twice in one source | Both are quarantined, whichever declarations found them. Rename or delete one. Only the same name in different sources is allowed.                                                                                                  |
| Source label reserved or duplicated                                                              | Change `name`. Two sources with one label cannot qualify a reference until one changes.                                                                                                                                             |

Bundle-provided sources are verified retained projections, identified separately from authored
sources and release-owned built-ins. They contribute no ordinary defaults to unrelated contexts;
explicit adoption can copy members into daily selection. Their bytes/mappings are immutable, and
`source-bundle-changed` requires restoring retained integrity or another dedicated context. Do not
relocate a projection or edit it as an authored source. Existing `import add` semantics remain
separate: profile export records current imported bytes/provenance without running import or fetching.
